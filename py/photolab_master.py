import os
import numpy as np
import torch
import torch.nn.functional as F
import folder_paths
import comfy.sd
import comfy.sample
import comfy.samplers
import comfy.model_management

# Register LUT folder in ComfyUI search paths if not registered
if "luts" not in folder_paths.folder_names_and_paths:
    base_lut_dir = os.path.join(folder_paths.models_dir, "luts")
    os.makedirs(base_lut_dir, exist_ok=True)
    folder_paths.folder_names_and_paths["luts"] = ([base_lut_dir], {".cube"})

# Register SAM model folder in ComfyUI search paths if not registered
if "sams" not in folder_paths.folder_names_and_paths:
    base_sam_dir = os.path.join(folder_paths.models_dir, "sams")
    os.makedirs(base_sam_dir, exist_ok=True)
    folder_paths.folder_names_and_paths["sams"] = ([base_sam_dir], {".pth", ".pt", ".safetensors", ".bin", ".onnx"})

# Cache stores for heavy resources
_CUBE_CACHE = {}
_CKPT_CACHE = {}
_SAM_CACHE = {}

def _get_sam_predictor(sam_model_name: str, device: torch.device):
    """Loads and caches a SAM checkpoint with local model weights."""
    global _SAM_CACHE
    sam_path = folder_paths.get_full_path("sams", sam_model_name)
    if sam_path is None or not os.path.exists(sam_path):
        models_dir = folder_paths.models_dir
        candidates = [
            os.path.join(models_dir, "sams", sam_model_name),
            os.path.join(models_dir, "sams", "sam_vit_b_01ec64.pth"),
        ]
        for c in candidates:
            if os.path.exists(c):
                sam_path = c
                break
    if sam_path is None or not os.path.exists(sam_path):
        raise FileNotFoundError(f"[MrWeaz - PhotoLab] SAM model checkpoint not found: {sam_model_name}")

    cache_key = (sam_path, str(device))
    if cache_key in _SAM_CACHE:
        return _SAM_CACHE[cache_key]

    from segment_anything import sam_model_registry, SamPredictor
    model_type = "vit_b"
    lower = os.path.basename(sam_path).lower()
    if "vit_h" in lower:
        model_type = "vit_h"
    elif "vit_l" in lower:
        model_type = "vit_l"
    elif "vit_b" in lower:
        model_type = "vit_b"

    sam = sam_model_registry[model_type](checkpoint=sam_path)
    sam.to(device=device)
    sam.eval()
    predictor = SamPredictor(sam)
    _SAM_CACHE[cache_key] = predictor
    return predictor

# Cache stores for local YOLO object & face detectors (Zero internet requests)
_YOLO_CACHE = {}

def _get_yolo_model(model_name: str):
    """Loads and caches a local YOLO model from models/ultralytics (zero internet requests)."""
    global _YOLO_CACHE
    if model_name in _YOLO_CACHE:
        return _YOLO_CACHE[model_name]
    models_dir = folder_paths.models_dir
    candidates = [
        os.path.join(models_dir, "ultralytics", "bbox", f"{model_name}.pt"),
        os.path.join(models_dir, "ultralytics", "segm", f"{model_name}.pt"),
        os.path.join(models_dir, "ultralytics", f"{model_name}.pt"),
    ]
    target_path = None
    for c in candidates:
        if os.path.exists(c):
            target_path = c
            break
    if not target_path:
        ultra_dir = os.path.join(models_dir, "ultralytics")
        if os.path.exists(ultra_dir):
            for root, _, files in os.walk(ultra_dir):
                for f in files:
                    if f.lower() == f"{model_name.lower()}.pt":
                        target_path = os.path.join(root, f)
                        break
                if target_path:
                    break
    if target_path:
        try:
            from ultralytics import YOLO
            yolo = YOLO(target_path)
            _YOLO_CACHE[model_name] = yolo
            return yolo
        except Exception:
            pass
    return None

# Automatic Depth Estimation via local ZoeDepth (Zero internet requests, uses cached weights)
_ZOE_MODEL = None

_ZOE_PROCESSOR = None



def _estimate_depth_zoe(img_bchw: torch.Tensor, device: torch.device) -> torch.Tensor:
    """Estimates a normalized [0.0 (near) -> 1.0 (far)] depth map [B, H, W, 1] using local ZoeDepth."""
    global _ZOE_MODEL, _ZOE_PROCESSOR
    if _ZOE_MODEL is None:
        try:
            from transformers import AutoImageProcessor, ZoeDepthForDepthEstimation
            model_name = "Intel/zoedepth-nyu-kitti"
            _ZOE_PROCESSOR = AutoImageProcessor.from_pretrained(model_name, local_files_only=True)
            _ZOE_MODEL = ZoeDepthForDepthEstimation.from_pretrained(model_name, local_files_only=True)
            _ZOE_MODEL.eval()
        except Exception:
            _ZOE_MODEL = False

    b, c, h, w = img_bchw.shape
    if _ZOE_MODEL and _ZOE_MODEL is not False:
        try:
            _ZOE_MODEL.to(device)
            scale = min(512.0 / max(h, w), 1.0)
            th, tw = max(64, int((h * scale) // 32) * 32), max(64, int((w * scale) // 32) * 32)
            x_in = F.interpolate(img_bchw[:, :3], size=(th, tw), mode="bilinear", align_corners=False)
            out = _ZOE_MODEL(pixel_values=x_in)
            pred = out.predicted_depth
            if pred.dim() == 3:
                pred = pred.unsqueeze(1)
            p_min = pred.min()
            p_max = pred.max()
            norm = (pred - p_min) / (p_max - p_min + 1e-6)
            d_b1hw = F.interpolate(norm, size=(h, w), mode="bilinear", align_corners=False)
            return d_b1hw.permute(0, 2, 3, 1)  # [B, H, W, 1]
        except Exception:
            pass

    # Seamless fallback: vertical distance gradient with center perspective
    y_lin = torch.linspace(0.0, 1.0, h, device=device, dtype=torch.float32).view(1, h, 1, 1).repeat(b, 1, w, 1)
    return y_lin


class PhotoLabMasterSuite:
    """
    Unified Virtual Darkroom, Optical Bench & Diffusion Retouch Suite.
    Integrates 14 physics-based and chemical photographic stages with explicit module on/off controls:
    1. RAW Decoding / Direct Image Ingest
    2. Neural Inpaint & Diffusion Retouch (Supports Z-Image Turbo / Flux / SDXL via model/clip/vae inputs or Checkpoint loader)
    3. True Frequency Separation (Tone smoothing + pore preservation)
    4. Subsurface Scattering (Subdermal skin terminator bleed)
    5. Studio Exposure Relighting (Inverse-square EV falloff)
    6. 3D .cube LUT Color Science (Trilinear interpolation + header resilience)
    7. Iconic Film Stock Emulations & Tone Balancing
    8. Filmic Highlight Shoulder Rolloff & Spectral Burnout
    9. Optical Pro-Mist Diffusion (Black Pro-Mist & Fog)
    10. Anamorphic Horizontal Streak Flares
    11. Multi-Spectral Anti-Halation (Red glow + amber core)
    12. Lateral Chromatic Aberration (Wavelength radial dispersion)
    13. Natural cos^4 Optical Vignetting
    14. Photochemical Zonal Silver Halide Grain (Isolated RNG)
    """

    STOCKS = [
        "None",
        "Kodak Portra 400",
        "Kodak Tri-X 400 (B&W)",
        "Kodak CineStill 800T",
        "Fuji Pro 400H",
        "Kodachrome 64",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        ckpts = ["None"] + folder_paths.get_filename_list("checkpoints")
        luts = ["None"] + folder_paths.get_filename_list("luts")
        sam_models = folder_paths.get_filename_list("sams")
        if not sam_models:
            sam_models = ["None"]
        samplers = comfy.samplers.KSampler.SAMPLERS
        schedulers = comfy.samplers.KSampler.SCHEDULERS

        return {
            "required": {
                # --- Primary Image Input & Auto-Depth Engine ---
                "image": ("IMAGE",),
                "auto_depth": ("BOOLEAN", {"default": True}),

                # --- Auto-Masking & SAM Engine ---
                "auto_mask": (["Disabled", "SAM Auto-Subject", "Depth Foreground Isolation", "Skin & Portrait Tones", "Specular Highlights", "Shadows & Blacks"], {"default": "Disabled"}),
                "sam_prompt": ("STRING", {"default": "subject"}),
                "sam_model": (sam_models, {"default": sam_models[0]}),
                "sam_point_x": ("FLOAT", {"default": 0.50, "min": 0.0, "max": 1.0, "step": 0.01}),
                "sam_point_y": ("FLOAT", {"default": 0.50, "min": 0.0, "max": 1.0, "step": 0.01}),
                "sam_depth_assist": ("BOOLEAN", {"default": True}),
                "invert_mask": ("BOOLEAN", {"default": False}),
                "mask_scope": (["Retouch Only", "All Effects"], {"default": "Retouch Only"}),

                # --- Module On/Off Toggles ---
                "enable_diffusion": ("BOOLEAN", {"default": False}),
                "enable_frequency_retouch": ("BOOLEAN", {"default": False}),
                "enable_sss": ("BOOLEAN", {"default": False}),
                "enable_relighting": ("BOOLEAN", {"default": False}),
                "enable_lut": ("BOOLEAN", {"default": False}),
                "enable_film_stock": ("BOOLEAN", {"default": False}),
                "enable_color_grade": ("BOOLEAN", {"default": False}),
                "enable_shoulder": ("BOOLEAN", {"default": False}),
                "enable_distortion": ("BOOLEAN", {"default": False}),
                "enable_dof": ("BOOLEAN", {"default": False}),
                "enable_atmosphere": ("BOOLEAN", {"default": False}),
                "enable_mist": ("BOOLEAN", {"default": False}),
                "enable_flare": ("BOOLEAN", {"default": False}),
                "enable_halation": ("BOOLEAN", {"default": False}),
                "enable_lateral_ca": ("BOOLEAN", {"default": False}),
                "enable_vignette": ("BOOLEAN", {"default": False}),
                "enable_grain": ("BOOLEAN", {"default": False}),

                # --- 1. Diffusion Neural Inpaint ---
                "checkpoint": (ckpts, {"default": "None"}),
                "positive_prompt": ("STRING", {
                    "multiline": True,
                    "default": "8k portrait, natural skin texture, clean smooth fabric, authentic pores, sharp focus, professional color grade"
                }),
                "negative_prompt": ("STRING", {
                    "multiline": True,
                    "default": "plastic skin, airbrushed, cartoon, oversaturated, blur, artifacts, noisy, deformed"
                }),
                "diff_denoise": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "diff_steps": ("INT", {"default": 8, "min": 1, "max": 50, "step": 1}),
                "diff_cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 12.0, "step": 0.1}),
                "sampler_name": (samplers, {"default": "euler"}),
                "scheduler": (schedulers, {"default": "simple"}),
                "mask_feather": ("INT", {"default": 16, "min": 0, "max": 128, "step": 2}),
                "diff_seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),

                # --- 2. Frequency Separation Retouch ---
                "skin_smooth": ("FLOAT", {"default": 0.40, "min": 0.0, "max": 1.0, "step": 0.05}),
                "smooth_radius": ("INT", {"default": 7, "min": 1, "max": 45, "step": 2}),
                "clarity": ("FLOAT", {"default": 0.15, "min": -1.0, "max": 1.0, "step": 0.05}),

                # --- 3. Subsurface Scattering (Subdermal Skin Bleed) ---
                "sss_amount": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.05}),
                "sss_radius": ("INT", {"default": 14, "min": 2, "max": 48, "step": 2}),
                "sss_tint_r": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.5, "step": 0.05}),
                "sss_tint_g": ("FLOAT", {"default": 0.28, "min": 0.0, "max": 1.0, "step": 0.05}),
                "sss_tint_b": ("FLOAT", {"default": 0.08, "min": 0.0, "max": 1.0, "step": 0.05}),

                # --- 4. Studio Relighting (3D Depth-Aware) ---
                "relight_use_depth": ("BOOLEAN", {"default": True}),
                "light_intensity": ("FLOAT", {"default": 0.35, "min": -2.0, "max": 2.0, "step": 0.05}),
                "light_x": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "light_y": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "light_z": ("FLOAT", {"default": 0.20, "min": 0.0, "max": 1.0, "step": 0.02}),
                "light_radius": ("FLOAT", {"default": 0.65, "min": 0.05, "max": 2.5, "step": 0.05}),
                "light_color_r": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "light_color_g": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 2.0, "step": 0.05}),
                "light_color_b": ("FLOAT", {"default": 0.88, "min": 0.0, "max": 2.0, "step": 0.05}),

                # --- 5. 3D .cube LUT Engine & Film Stock Presets ---
                "lut_file": (luts, {"default": "None"}),
                "lut_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "film_stock": (cls.STOCKS, {"default": "Kodak Portra 400"}),
                "stock_mix": ("FLOAT", {"default": 0.80, "min": 0.0, "max": 1.0, "step": 0.05}),

                # --- 6. Manual Color Grade & Tone ---
                "exposure": ("FLOAT", {"default": 0.0, "min": -3.0, "max": 3.0, "step": 0.05}),
                "contrast": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.05}),
                "temperature": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                "tint": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                "saturation": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),

                # --- 7. Film Shoulder Highlight Rolloff ---
                "shoulder_start": ("FLOAT", {"default": 0.72, "min": 0.4, "max": 1.0, "step": 0.02}),
                "rolloff_softness": ("FLOAT", {"default": 0.80, "min": 0.1, "max": 1.5, "step": 0.05}),
                "highlight_desat": ("FLOAT", {"default": 0.60, "min": 0.0, "max": 1.0, "step": 0.05}),

                # --- 8. Optical Depth of Field (Disc Bokeh & F-Stop) ---
                "dof_use_depth": ("BOOLEAN", {"default": True}),
                "f_stop": (["Manual", "f/1.2", "f/1.4", "f/1.8", "f/2.0", "f/2.8", "f/4.0", "f/5.6", "f/8.0", "f/11", "f/16", "f/22"], {"default": "f/2.0"}),
                "dof_intensity": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.0, "step": 0.01}),
                "dof_auto_focus": ("BOOLEAN", {"default": True}),
                "dof_sharpness_radius": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "dof_focus_point": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01}),

                # --- 9. Atmospheric Haze & Silhouette Light Wrap ---
                "haze_use_depth": ("BOOLEAN", {"default": True}),
                "light_wrap_use_depth": ("BOOLEAN", {"default": True}),
                "haze_strength": ("FLOAT", {"default": 0.40, "min": 0.0, "max": 1.0, "step": 0.05}),
                "lift_blacks": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.02}),
                "depth_offset": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                "haze_color_r": ("FLOAT", {"default": 0.16, "min": 0.0, "max": 1.0, "step": 0.02}),
                "haze_color_g": ("FLOAT", {"default": 0.19, "min": 0.0, "max": 1.0, "step": 0.02}),
                "haze_color_b": ("FLOAT", {"default": 0.26, "min": 0.0, "max": 1.0, "step": 0.02}),
                "light_wrap_strength": ("FLOAT", {"default": 0.30, "min": 0.0, "max": 1.0, "step": 0.05}),

                # --- 10. Optical Mist Diffusion (Pro-Mist) ---
                "mist_type": (["Black Pro-Mist", "White Diffusion / Fog"], {"default": "Black Pro-Mist"}),
                "mist_intensity": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.5, "step": 0.05}),
                "mist_radius": ("INT", {"default": 28, "min": 6, "max": 96, "step": 2}),
                "mist_cutoff": ("FLOAT", {"default": 0.60, "min": 0.2, "max": 0.95, "step": 0.05}),

                # --- 11. Realistic Multi-Spectral Halation ---
                "halation_intensity": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 2.0, "step": 0.05}),
                "halation_spread": ("INT", {"default": 20, "min": 4, "max": 80, "step": 2}),
                "halation_threshold": ("FLOAT", {"default": 0.78, "min": 0.4, "max": 1.0, "step": 0.02}),
                "halation_amber_core": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.05}),

                # --- 12. Lens Geometry & Curvature ---
                "lens_distortion": ("FLOAT", {"default": -0.015, "min": -0.30, "max": 0.30, "step": 0.001}),
                "lateral_ca": ("FLOAT", {"default": 0.003, "min": -0.04, "max": 0.04, "step": 0.001}),
                "anamorphic_flare": ("FLOAT", {"default": 0.30, "min": 0.0, "max": 2.0, "step": 0.05}),
                "vignette_amount": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 2.0, "step": 0.05}),

                # --- 13. Physical Zonal Silver Halide Grain ---
                "grain_amount": ("FLOAT", {"default": 0.20, "min": 0.0, "max": 2.0, "step": 0.02}),
                "grain_size": ("FLOAT", {"default": 1.4, "min": 0.8, "max": 4.0, "step": 0.1}),
                "grain_shadows": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 2.0, "step": 0.05}),
                "grain_midtones": ("FLOAT", {"default": 0.90, "min": 0.0, "max": 2.0, "step": 0.05}),
                "grain_highlights": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 2.0, "step": 0.05}),
                "grain_color": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "grain_seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff}),
            },
            "optional": {
                "depth_map": ("IMAGE",),
                "mask": ("MASK",),
                # Modular Diffusion inputs (Z-Image Turbo, Flux, Hunyuan, SDXL, etc.)
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "depth_map", "mask")
    FUNCTION = "process_everything"
    CATEGORY = "MrWeazNodes/PhotoLab"

    def _gaussian_blur(self, tensor: torch.Tensor, radius: int) -> torch.Tensor:
        """Fast separable 2D Gaussian blur for [B, C, H, W] tensors."""
        if radius <= 0:
            return tensor
        k = int(radius * 2) | 1
        if k <= 1:
            return tensor
        sigma = max(0.5, float(radius) / 2.0)
        coords = torch.arange(-(k // 2), (k // 2) + 1, dtype=torch.float32, device=tensor.device)
        k1d = torch.exp(-0.5 * (coords / sigma) ** 2)
        k1d = k1d / k1d.sum()

        c = tensor.shape[1]
        k_h = k1d.view(1, 1, k, 1).repeat(c, 1, 1, 1)
        k_w = k1d.view(1, 1, 1, k).repeat(c, 1, 1, 1)

        pad = k // 2
        out = F.pad(tensor, (0, 0, pad, pad), mode="reflect")
        out = F.conv2d(out, k_h, groups=c)
        out = F.pad(out, (pad, pad, 0, 0), mode="reflect")
        return F.conv2d(out, k_w, groups=c)

    def _normalize_mask(self, mask: torch.Tensor, b: int, h: int, w: int, device: torch.device) -> torch.Tensor:
        """Standardizes masks to [B, 1, H, W] float32 tensor, resolving 5D/4D/3D/2D variants."""
        if mask is None:
            return torch.ones((b, 1, h, w), device=device, dtype=torch.float32)

        m = mask.to(device=device, dtype=torch.float32)
        if m.dim() == 5:
            if m.shape[1] == 1:
                m = m.squeeze(1)
            elif m.shape[2] == 1:
                m = m.squeeze(2)
            else:
                m = m[:, 0]
        elif m.dim() == 2:
            m = m.unsqueeze(0).unsqueeze(0)
        elif m.dim() == 3:
            m = m.unsqueeze(1)
        elif m.dim() == 4:
            if m.shape[-1] in (1, 3, 4):
                # [B, H, W, C] -> [B, 1, H, W]
                m = m[..., 0:1].permute(0, 3, 1, 2)
            elif m.shape[1] in (1, 3, 4):
                # [B, C, H, W] -> [B, 1, H, W]
                m = m[:, 0:1]
            else:
                m = m[:, 0:1]

        if m.shape[0] > b:
            m = m[:b]
        elif m.shape[0] < b:
            m = m.repeat(b // m.shape[0] + 1, 1, 1, 1)[:b]

        if m.shape[2] != h or m.shape[3] != w:
            m = F.interpolate(m, size=(h, w), mode="bilinear", align_corners=False)

        return torch.clamp(m, 0.0, 1.0)

    def _generate_auto_mask(
        self,
        mode: str,
        img_bhwc: torch.Tensor,
        depth_mask: torch.Tensor,
        sam_model_name: str,
        point_x: float,
        point_y: float,
        depth_assist: bool,
        device: torch.device,
        sam_prompt: str = "subject",
    ) -> torch.Tensor:
        """Generates a [B, 1, H, W] float32 mask using SAM or algorithmic heuristics."""
        B, H, W, C = img_bhwc.shape
        prompt_txt = (sam_prompt or "").strip().lower()

        # Semantic redirection: if user typed specific keywords, adjust focus coordinates
        eff_point_x = point_x
        eff_point_y = point_y
        if prompt_txt:
            if any(k in prompt_txt for k in ["skin", "face", "portrait", "head"]):
                if eff_point_x == 0.50 and eff_point_y == 0.50:
                    eff_point_y = 0.30
            elif any(k in prompt_txt for k in ["legs", "feet", "shoes", "bottom"]):
                if eff_point_x == 0.50 and eff_point_y == 0.50:
                    eff_point_y = 0.82
            elif "left" in prompt_txt and eff_point_x == 0.50:
                eff_point_x = 0.28
            elif "right" in prompt_txt and eff_point_x == 0.50:
                eff_point_x = 0.72

            # Direct coordinate syntax: "0.35, 0.45"
            if "," in prompt_txt:
                parts = prompt_txt.replace("(", "").replace(")", "").split(",")
                try:
                    c_x = float(parts[0].strip())
                    c_y = float(parts[1].strip())
                    if 0.0 <= c_x <= 1.0 and 0.0 <= c_y <= 1.0:
                        eff_point_x = c_x
                        eff_point_y = c_y
                except Exception:
                    pass

        if mode == "SAM Auto-Subject":
            try:
                predictor = _get_sam_predictor(sam_model_name, device)
                masks_list = []
                for b_idx in range(B):
                    img_np = (torch.clamp(img_bhwc[b_idx, :, :, :3], 0.0, 1.0).detach().cpu().numpy() * 255.0).astype(np.uint8)
                    predictor.set_image(img_np)

                    boxes_to_segment = []

                    # 1. Face / Head / Portrait
                    if any(k in prompt_txt for k in ["face", "head", "portrait", "visage", "forehead", "cheeks"]):
                        yolo_f = _get_yolo_model("face_yolov8m")
                        if yolo_f:
                            try:
                                res_f = yolo_f(img_np, verbose=False)
                                if len(res_f) > 0 and len(res_f[0].boxes) > 0:
                                    boxes_to_segment.extend(res_f[0].boxes.xyxy.cpu().numpy())
                            except Exception:
                                pass

                    # 2. Lips / Mouth
                    elif any(k in prompt_txt for k in ["lips", "mouth", "smile"]):
                        yolo_lips = _get_yolo_model("lips-v1")
                        if yolo_lips:
                            try:
                                res_l = yolo_lips(img_np, verbose=False)
                                if len(res_l) > 0 and len(res_l[0].boxes) > 0:
                                    boxes_to_segment.extend(res_l[0].boxes.xyxy.cpu().numpy())
                            except Exception:
                                pass
                        if not boxes_to_segment:
                            yolo_f = _get_yolo_model("face_yolov8m")
                            if yolo_f:
                                try:
                                    res_f = yolo_f(img_np, verbose=False)
                                    for b in res_f[0].boxes.xyxy.cpu().numpy():
                                        x0, y0, x1, y1 = b
                                        fh = y1 - y0
                                        boxes_to_segment.append([x0, y1 - fh * 0.38, x1, y1])
                                except Exception:
                                    pass

                    # 3. Eyes
                    elif any(k in prompt_txt for k in ["eye", "eyes", "pupil"]):
                        yolo_f = _get_yolo_model("face_yolov8m")
                        if yolo_f:
                            try:
                                res_f = yolo_f(img_np, verbose=False)
                                for b in res_f[0].boxes.xyxy.cpu().numpy():
                                    x0, y0, x1, y1 = b
                                    fh = y1 - y0
                                    boxes_to_segment.append([x0, y0 + fh * 0.18, x1, y0 + fh * 0.55])
                            except Exception:
                                pass

                    # 4. Hair
                    elif any(k in prompt_txt for k in ["hair", "hairstyle", "bangs", "curls"]):
                        yolo_f = _get_yolo_model("face_yolov8m")
                        if yolo_f:
                            try:
                                res_f = yolo_f(img_np, verbose=False)
                                for b in res_f[0].boxes.xyxy.cpu().numpy():
                                    x0, y0, x1, y1 = b
                                    fw = x1 - x0
                                    fh = y1 - y0
                                    boxes_to_segment.append([
                                        max(0, x0 - fw * 0.25),
                                        max(0, y0 - fh * 0.45),
                                        min(W - 1, x1 + fw * 0.25),
                                        min(H - 1, y0 + fh * 0.40)
                                    ])
                            except Exception:
                                pass

                    # 5. Hands
                    elif any(k in prompt_txt for k in ["hand", "hands", "finger", "fingers", "fist", "palm"]):
                        yolo_h = _get_yolo_model("hand_yolov8s")
                        if yolo_h:
                            try:
                                res_h = yolo_h(img_np, verbose=False)
                                if len(res_h) > 0 and len(res_h[0].boxes) > 0:
                                    boxes_to_segment.extend(res_h[0].boxes.xyxy.cpu().numpy())
                            except Exception:
                                pass

                    # 6. Clothes / Outfit / Body
                    elif any(k in prompt_txt for k in ["clothes", "clothing", "shirt", "jacket", "dress", "pants", "suit", "coat", "sweater", "hoodie", "jeans"]):
                        yolo_coco = _get_yolo_model("yolov8n")
                        if yolo_coco:
                            try:
                                res_c = yolo_coco(img_np, verbose=False)
                                for b in res_c[0].boxes:
                                    cname = yolo_coco.names.get(int(b.cls[0].item()), "")
                                    if cname == "person":
                                        x0, y0, x1, y1 = b.xyxy[0].cpu().numpy()
                                        ph = y1 - y0
                                        boxes_to_segment.append([x0, y0 + ph * 0.20, x1, y1])
                            except Exception:
                                pass

                    # 7. General Objects & COCO Classes
                    else:
                        yolo_coco = _get_yolo_model("yolov8n")
                        if yolo_coco:
                            try:
                                res_c = yolo_coco(img_np, verbose=False)
                                target_clss = set()
                                for cid, cname in yolo_coco.names.items():
                                    if cname in prompt_txt:
                                        target_clss.add(cid)
                                synonyms = {
                                    "person": ["person", "man", "woman", "girl", "boy", "human", "model", "people"],
                                    "cat": ["cat", "kitty", "kitten", "feline"],
                                    "dog": ["dog", "puppy", "canine", "hound", "pet"],
                                    "car": ["car", "automobile", "vehicle"],
                                    "chair": ["chair", "seat", "stool", "armchair"],
                                    "couch": ["couch", "sofa"],
                                    "bottle": ["bottle", "flask"],
                                    "cup": ["cup", "mug", "glass"],
                                    "laptop": ["laptop", "computer", "pc"],
                                    "cell phone": ["phone", "smartphone", "mobile"],
                                    "backpack": ["backpack", "bag", "knapsack"],
                                    "handbag": ["handbag", "purse"],
                                    "umbrella": ["umbrella"],
                                    "tie": ["tie", "necktie"],
                                    "bicycle": ["bicycle", "bike"],
                                    "motorcycle": ["motorcycle", "motorbike"],
                                    "boat": ["boat", "ship", "yacht"],
                                    "airplane": ["airplane", "plane", "jet"],
                                    "bird": ["bird"],
                                    "horse": ["horse"],
                                }
                                for orig_name, syn_list in synonyms.items():
                                    if any(s in prompt_txt for s in syn_list):
                                        for cid, cname in yolo_coco.names.items():
                                            if cname == orig_name:
                                                target_clss.add(cid)
                                if target_clss:
                                    for b in res_c[0].boxes:
                                        if int(b.cls[0].item()) in target_clss:
                                            boxes_to_segment.append(b.xyxy[0].cpu().numpy())
                            except Exception:
                                pass

                    # Segment detected boxes with SAM
                    if boxes_to_segment:
                        b_mask = np.zeros((H, W), dtype=np.float32)
                        for box in boxes_to_segment:
                            try:
                                m, s, _ = predictor.predict(box=np.array(box, dtype=np.float32), multimask_output=False)
                                b_mask = np.maximum(b_mask, m[0].astype(np.float32))
                            except Exception:
                                pass
                        masks_list.append(torch.from_numpy(b_mask).to(device=device))
                    else:
                        # Fallback: Point prompt with depth assistance or coordinates
                        px = int(eff_point_x * (W - 1))
                        py = int(eff_point_y * (H - 1))

                        if depth_assist and depth_mask is not None and not ("," in prompt_txt):
                            rad_y, rad_x = max(8, int(H * 0.20)), max(8, int(W * 0.20))
                            y0, y1 = max(0, py - rad_y), min(H, py + rad_y)
                            x0, x1 = max(0, px - rad_x), min(W, px + rad_x)
                            if depth_mask.shape[0] > b_idx:
                                patch = depth_mask[b_idx, y0:y1, x0:x1, 0]
                                min_pos = torch.argmin(patch)
                                py = y0 + (min_pos // (x1 - x0)).item()
                                px = x0 + (min_pos % (x1 - x0)).item()

                        coords = np.array([[px, py]], dtype=np.float32)
                        labels = np.array([1], dtype=np.int32)
                        masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels, multimask_output=True)
                        best_m = masks[np.argmax(scores)]
                        masks_list.append(torch.from_numpy(best_m.astype(np.float32)).to(device=device))

                return torch.stack(masks_list, dim=0).unsqueeze(1)  # [B, 1, H, W]
            except Exception as e:
                print(f"[MrWeaz - PhotoLab] Warning: SAM auto-masking encountered an error ({e}). Falling back to depth foreground.")
                mode = "Depth Foreground Isolation"


        if mode == "Depth Foreground Isolation":
            if depth_mask is not None:
                d_in = depth_mask.permute(0, 3, 1, 2)  # [B, 1, H, W]
                fg = torch.sigmoid((0.40 - d_in) * 12.0)
                return torch.clamp(fg, 0.0, 1.0)
            else:
                y = torch.linspace(-1.0, 1.0, H, device=device, dtype=torch.float32).view(1, 1, H, 1)
                x = torch.linspace(-1.0, 1.0, W, device=device, dtype=torch.float32).view(1, 1, 1, W)
                r = torch.sqrt(x ** 2 + y ** 2)
                return torch.clamp(1.0 - r, 0.0, 1.0).repeat(B, 1, 1, 1)

        elif mode == "Skin & Portrait Tones":
            r = img_bhwc[..., 0:1]
            g = img_bhwc[..., 1:2]
            b = img_bhwc[..., 2:3]
            rg_diff = torch.clamp((r - g) * 5.0, 0.0, 1.0)
            gb_diff = torch.clamp((g - b) * 4.0, 0.0, 1.0)
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            lum_mask = torch.clamp((lum - 0.15) * 4.0, 0.0, 1.0) * torch.clamp((0.92 - lum) * 4.0, 0.0, 1.0)
            skin = rg_diff * gb_diff * lum_mask
            return skin.permute(0, 3, 1, 2)  # [B, 1, H, W]

        elif mode == "Specular Highlights":
            r = img_bhwc[..., 0:1]
            g = img_bhwc[..., 1:2]
            b = img_bhwc[..., 2:3]
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            hi = torch.clamp((lum - 0.70) / 0.25, 0.0, 1.0)
            return hi.permute(0, 3, 1, 2)  # [B, 1, H, W]

        elif mode == "Shadows & Blacks":
            r = img_bhwc[..., 0:1]
            g = img_bhwc[..., 1:2]
            b = img_bhwc[..., 2:3]
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            sh = torch.clamp((0.30 - lum) / 0.25, 0.0, 1.0)
            return sh.permute(0, 3, 1, 2)  # [B, 1, H, W]

        return torch.ones((B, 1, H, W), device=device, dtype=torch.float32)

    def _load_cube_lut(self, lut_path: str, device: torch.device) -> torch.Tensor:
        """Parses a .cube file into a 3D PyTorch texture for trilinear grid_sample with caching."""
        key = (lut_path, str(device))
        if key in _CUBE_CACHE:
            return _CUBE_CACHE[key]

        size = None
        data = []
        with open(lut_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("LUT_3D_SIZE"):
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].isdigit():
                        size = int(parts[1])
                    continue
                if line.startswith(("TITLE", "DOMAIN_", "LUT_1D", "LUT_2D")):
                    continue
                parts = line.split()
                if len(parts) == 3:
                    try:
                        data.append([float(parts[0]), float(parts[1]), float(parts[2])])
                    except ValueError:
                        continue

        if size is None or len(data) != size * size * size:
            raise ValueError(f"Invalid or unsupported .cube LUT file: {lut_path}")

        lut_tensor = torch.tensor(data, dtype=torch.float32, device=device)
        # .cube format ordered R fast, G mid, B slow -> reshape to [1, 3, B, G, R]
        lut_tensor = lut_tensor.view(size, size, size, 3).permute(3, 0, 1, 2).unsqueeze(0)
        _CUBE_CACHE[key] = lut_tensor
        return lut_tensor

    def _apply_3d_lut(self, img_bchw: torch.Tensor, lut_tensor: torch.Tensor) -> torch.Tensor:
        """Executes trilinear interpolation through 3D LUT texture."""
        grid = (img_bchw.permute(0, 2, 3, 1) * 2.0 - 1.0).unsqueeze(1)  # [B, 1, H, W, 3]
        lut_in = lut_tensor if lut_tensor.shape[0] == img_bchw.shape[0] else lut_tensor.repeat(img_bchw.shape[0], 1, 1, 1, 1)
        graded = F.grid_sample(lut_in, grid, mode="bilinear", padding_mode="border", align_corners=True)
        return graded.squeeze(2)

    def _get_checkpoint(self, ckpt_name: str):
        """Loads and caches model, clip, vae tuple."""
        ckpt_path = folder_paths.get_full_path("checkpoints", ckpt_name)
        if not ckpt_path or not os.path.exists(ckpt_path):
            raise FileNotFoundError(f"Checkpoint not found: {ckpt_name}")
        if ckpt_name in _CKPT_CACHE:
            return _CKPT_CACHE[ckpt_name]
        loaded = comfy.sd.load_checkpoint_guess_config(ckpt_path, output_vae=True, output_clip=True)
        _CKPT_CACHE[ckpt_name] = (loaded[0], loaded[1], loaded[2])
        return _CKPT_CACHE[ckpt_name]

    def process_everything(
        self,
        image=None,
        auto_depth=True,
        auto_mask="Disabled",
        sam_prompt="subject",
        sam_model="None",
        sam_point_x=0.50,
        sam_point_y=0.50,
        sam_depth_assist=True,
        invert_mask=False,
        mask_scope="Retouch Only",
        enable_diffusion=False,
        enable_frequency_retouch=False,
        enable_sss=False,
        enable_relighting=False,
        enable_lut=False,
        enable_film_stock=False,
        enable_color_grade=False,
        enable_shoulder=False,
        enable_distortion=False,
        enable_dof=False,
        enable_atmosphere=False,
        enable_mist=False,
        enable_flare=False,
        enable_halation=False,
        enable_lateral_ca=False,
        enable_vignette=False,
        enable_grain=False,
        checkpoint="None",
        positive_prompt="",
        negative_prompt="",
        diff_denoise=0.25,
        diff_steps=8,
        diff_cfg=1.0,
        sampler_name="euler",
        scheduler="simple",
        mask_feather=16,
        diff_seed=0,
        skin_smooth=0.40,
        smooth_radius=7,
        clarity=0.15,
        sss_amount=0.25,
        sss_radius=14,
        sss_tint_r=1.0,
        sss_tint_g=0.28,
        sss_tint_b=0.08,
        relight_use_depth=True,
        light_intensity=0.35,
        light_x=0.5,
        light_y=0.5,
        light_z=0.20,
        light_radius=0.65,
        light_color_r=1.0,
        light_color_g=0.95,
        light_color_b=0.88,
        lut_file="None",
        lut_strength=1.0,
        film_stock="Kodak Portra 400",
        stock_mix=0.80,
        exposure=0.0,
        contrast=1.0,
        temperature=0.0,
        tint=0.0,
        saturation=1.0,
        shoulder_start=0.72,
        rolloff_softness=0.80,
        highlight_desat=0.60,
        dof_use_depth=True,
        f_stop="f/2.0",
        dof_intensity=0.35,
        dof_auto_focus=True,
        dof_sharpness_radius=0.25,
        dof_focus_point=0.15,
        haze_use_depth=True,
        light_wrap_use_depth=True,
        haze_strength=0.40,
        lift_blacks=0.10,
        depth_offset=0.0,
        haze_color_r=0.16,
        haze_color_g=0.19,
        haze_color_b=0.26,
        light_wrap_strength=0.30,
        lens_distortion=-0.015,
        mist_type="Black Pro-Mist",
        mist_intensity=0.25,
        mist_radius=28,
        mist_cutoff=0.60,
        halation_intensity=0.25,
        halation_spread=20,
        halation_threshold=0.78,
        halation_amber_core=0.45,
        lateral_ca=0.003,
        anamorphic_flare=0.30,
        vignette_amount=0.25,
        grain_amount=0.20,
        grain_size=1.4,
        grain_shadows=0.45,
        grain_midtones=0.90,
        grain_highlights=0.25,
        grain_color=0.0,
        grain_seed=42,
        depth_map=None,
        mask=None,
        model=None,
        clip=None,
        vae=None,
        positive=None,
        negative=None,
        pipe_model=None,
        pipe_clip=None,
        pipe_vae=None,
        raw_file_path="",
        use_camera_wb=True,
        **kwargs
    ):
        device = comfy.model_management.get_torch_device()

        # -------------------------------------------------------------
        # STEP 1: Image Ingest & Validation
        # -------------------------------------------------------------
        if image is not None:
            img = image.clone().to(device=device, dtype=torch.float32)
        else:
            raise ValueError("PhotoLabMasterSuite: 'image' input socket must be connected.")

        # Ensure img is strictly 4D [B, H, W, C]
        if img.dim() == 5:
            if img.shape[1] == 1:
                img = img.squeeze(1)
            elif img.shape[2] == 1:
                img = img.squeeze(2)
            elif img.shape[-1] in (1, 3, 4):
                img = img[:, 0]
            else:
                img = img[:, :, 0]
        elif img.dim() == 3:
            img = img.unsqueeze(0)

        # Automatic Alpha Channel removal (RGBA -> RGB)
        if img.shape[-1] == 4:
            img = img[..., :3]

        B, H, W, C = img.shape
        orig_img = img.clone()

        # -------------------------------------------------------------
        # STEP 1.5: Automatic or External 3D Depth Map Estimation
        # (Calculated early so Depth-Assisted SAM and Depth Foreground Isolation have access)
        # -------------------------------------------------------------
        needs_depth = (
            (enable_dof and dof_use_depth)
            or (enable_atmosphere and (haze_use_depth or light_wrap_use_depth))
            or (enable_relighting and relight_use_depth)
            or (auto_mask in ("SAM Auto-Subject", "Depth Foreground Isolation"))
        )

        depth_mask = None
        if depth_map is not None:
            d = depth_map.clone().to(device=device, dtype=torch.float32)
            if d.dim() == 5:
                if d.shape[1] == 1:
                    d = d.squeeze(1)
                elif d.shape[2] == 1:
                    d = d.squeeze(2)
                elif d.shape[-1] in (1, 3, 4):
                    d = d[:, 0]
                else:
                    d = d[:, :, 0]
            if d.dim() == 4:
                if d.shape[-1] in (3, 4):
                    d = d[..., 0:1]
                elif d.shape[1] in (1, 3, 4):
                    d = d.permute(0, 2, 3, 1)[:, :, :, 0:1]
            elif d.dim() == 3:
                d = d.unsqueeze(-1)
            if d.shape[1] != H or d.shape[2] != W:
                d = F.interpolate(d.permute(0, 3, 1, 2), size=(H, W), mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
            if d.shape[0] > B:
                d = d[:B]
            elif d.shape[0] < B:
                d = d.repeat(B // d.shape[0] + 1, 1, 1, 1)[:B]
            depth_mask = torch.clamp(d + depth_offset, 0.0, 1.0)
        elif auto_depth and needs_depth:
            raw_depth = _estimate_depth_zoe(img.permute(0, 3, 1, 2), device)
            depth_mask = torch.clamp(raw_depth + depth_offset, 0.0, 1.0)
        elif needs_depth:
            y_lin = torch.linspace(0.0, 1.0, H, device=device, dtype=torch.float32).view(1, H, 1, 1).repeat(B, 1, W, 1)
            depth_mask = torch.clamp(y_lin + depth_offset, 0.0, 1.0)

        # -------------------------------------------------------------
        # STEP 1.6: Active Mask Resolution (SAM / Heuristics / Inversion / Feather)
        # -------------------------------------------------------------
        user_mask = self._normalize_mask(mask, B, H, W, device) if mask is not None else None
        
        prompt_txt = (sam_prompt or "").strip().lower()
        eff_auto_mask = auto_mask
        if eff_auto_mask == "Disabled" and prompt_txt and prompt_txt not in ("none", "disabled", "off", ""):
            eff_auto_mask = "SAM Auto-Subject"

        if eff_auto_mask != "Disabled":
            auto_m = self._generate_auto_mask(
                mode=eff_auto_mask,
                img_bhwc=img,
                depth_mask=depth_mask,
                sam_model_name=sam_model,
                point_x=sam_point_x,
                point_y=sam_point_y,
                depth_assist=sam_depth_assist,
                device=device,
                sam_prompt=sam_prompt,
            )
            if user_mask is not None:
                active_mask = user_mask * auto_m
            else:
                active_mask = auto_m
        else:
            active_mask = user_mask

        should_invert = invert_mask or any(k in prompt_txt for k in ["background", "backdrop", "sky", "scenery", "wall", "environment", "room", "surroundings"])
        if active_mask is not None and should_invert:
            active_mask = torch.clamp(1.0 - active_mask, 0.0, 1.0)


        if active_mask is not None and mask_feather > 0:
            active_mask = self._gaussian_blur(active_mask, mask_feather)

        # -------------------------------------------------------------
        # STEP 1.7: Empty Mask Check (Zero sum -> completely bypass everything)
        # -------------------------------------------------------------
        if active_mask is not None and active_mask.sum().item() < 1e-5:
            print("[MrWeaz - PhotoLab] Active mask is empty (sum=0). Bypassing all processing (original image returned untouched).")
            if depth_mask is not None:
                depth_out = depth_mask[:B].repeat(1, 1, 1, 3).cpu().contiguous()
            else:
                depth_out = torch.full((B, H, W, 3), 0.5, dtype=torch.float32)
            mask_out = torch.zeros((B, H, W, 3), dtype=torch.float32)
            return (orig_img.cpu().contiguous(), depth_out, mask_out)

        # -------------------------------------------------------------
        # STEP 1.8: Neural Diffusion Inpaint & Retouch (Runs FIRST)
        # Supports Flux / SD / external models via connected model/clip/vae OR Checkpoint loader
        # -------------------------------------------------------------
        active_model = model if model is not None else pipe_model
        active_clip = clip if clip is not None else pipe_clip
        active_vae = vae if vae is not None else pipe_vae

        has_modular_inputs = active_model is not None and active_vae is not None
        has_ckpt = checkpoint is not None and checkpoint != "None" and checkpoint != ""

        if enable_diffusion:
            if not (has_modular_inputs or has_ckpt):
                raise ValueError(
                    "[MrWeaz - PhotoLab] Neural Diffusion Inpaint is enabled, but no diffusion model is provided!\n"
                    "Please connect 'model' and 'vae' (and optionally 'clip') to the node inputs,\n"
                    "OR select a model checkpoint from the 'Model Checkpoint' dropdown in the Retouch & AI tab."
                )

            if diff_denoise > 0.0001:
                print(f"[MrWeaz - PhotoLab] Running Neural Diffusion Inpaint: steps={diff_steps}, cfg={diff_cfg}, denoise={diff_denoise}, sampler={sampler_name}/{scheduler}")
                if has_modular_inputs:
                    diff_model = active_model
                    diff_clip = active_clip
                    diff_vae = active_vae
                else:
                    diff_model, diff_clip, diff_vae = self._get_checkpoint(checkpoint)

                # Conditioning resolution
                if positive is not None:
                    cond_p = positive
                elif diff_clip is not None:
                    tokens_p = diff_clip.tokenize(positive_prompt)
                    cond_p = diff_clip.encode_from_tokens_scheduled(tokens_p)
                else:
                    cond_p = []

                if negative is not None:
                    cond_n = negative
                elif diff_clip is not None:
                    tokens_n = diff_clip.tokenize(negative_prompt)
                    cond_n = diff_clip.encode_from_tokens_scheduled(tokens_n)
                else:
                    cond_n = []

                if len(cond_n) == 0 and diff_cfg > 1.0 and len(cond_p) > 0:
                    cond_n = cond_p

                has_inpaint_mask = active_mask is not None
                if has_inpaint_mask:
                    f_mask = active_mask
                else:
                    f_mask = None

                latent_image = diff_vae.encode(torch.clamp(img[:, :, :, :3], 0.0, 1.0).contiguous())
                if latent_image.dim() == 5:
                    if latent_image.shape[2] == 1:
                        latent_image = latent_image.squeeze(2)
                    elif latent_image.shape[1] == 1:
                        latent_image = latent_image.squeeze(1)
                    else:
                        latent_image = latent_image[:, :, 0]

                latent_image = latent_image[:B]
                latent_image = comfy.sample.fix_empty_latent_channels(diff_model, latent_image)
                latent_image = latent_image[:B]

                if has_inpaint_mask and f_mask is not None:
                    lh, lw = latent_image.shape[-2], latent_image.shape[-1]
                    latent_noise_mask = F.interpolate(f_mask[:B], size=(lh, lw), mode="bilinear", align_corners=False)
                    latent_noise_mask = latent_noise_mask.to(device=latent_image.device, dtype=torch.float32)
                    latent_noise_mask = latent_noise_mask[:B]
                else:
                    latent_noise_mask = None

                noise = comfy.sample.prepare_noise(latent_image, diff_seed)
                noise = noise[:B]

                samples = comfy.sample.sample(
                    model=diff_model,
                    noise=noise,
                    steps=diff_steps,
                    cfg=diff_cfg,
                    sampler_name=sampler_name,
                    scheduler=scheduler,
                    positive=cond_p,
                    negative=cond_n,
                    latent_image=latent_image,
                    denoise=diff_denoise,
                    disable_noise=False,
                    noise_mask=latent_noise_mask,
                    seed=diff_seed,
                )
                samples = samples[:B]

                decoded = diff_vae.decode(samples)
                if decoded.dim() == 5:
                    if decoded.shape[1] == 1:
                        decoded = decoded.squeeze(1)
                    elif decoded.shape[2] == 1:
                        decoded = decoded.squeeze(2)
                    elif decoded.shape[-1] in (1, 3, 4):
                        decoded = decoded[:, 0]
                    else:
                        decoded = decoded[:, :, 0]
                elif decoded.dim() == 3:
                    decoded = decoded.unsqueeze(0)

                decoded = decoded.to(device=device, dtype=torch.float32)
                decoded = torch.clamp(decoded, 0.0, 1.0)
                decoded = decoded[:B]

                if decoded.shape[1] != H or decoded.shape[2] != W:
                    decoded = decoded.permute(0, 3, 1, 2)
                    decoded = F.interpolate(decoded, size=(H, W), mode="bilinear", align_corners=False).permute(0, 2, 3, 1)

                if has_inpaint_mask and f_mask is not None:
                    m_blend = f_mask[:B].permute(0, 2, 3, 1)
                    smooth_blend = m_blend * m_blend * (3.0 - 2.0 * m_blend)
                    img = torch.lerp(img[:B], decoded, smooth_blend)
                else:
                    img = decoded
                img = img[:B]
                print(f"[MrWeaz - PhotoLab] Neural Diffusion Inpaint complete: generated image shape {list(img.shape)}. Applying downstream optical/darkroom effects...")

                # Update depth map on newly inpainted image if depth is needed
                if auto_depth and (
                    (enable_dof and dof_use_depth)
                    or (enable_atmosphere and (haze_use_depth or light_wrap_use_depth))
                    or (enable_relighting and relight_use_depth)
                ):
                    raw_depth = _estimate_depth_zoe(img.permute(0, 3, 1, 2), device)
                    depth_mask = torch.clamp(raw_depth + depth_offset, 0.0, 1.0)

        # -------------------------------------------------------------
        # STEP 2: Camera Lens Geometry & Curvature (Barrel / Pincushion)
        # -------------------------------------------------------------
        if enable_distortion and abs(lens_distortion) > 0.0005:
            y_d = torch.linspace(-1.0, 1.0, H, device=device, dtype=torch.float32)
            x_d = torch.linspace(-1.0, 1.0, W, device=device, dtype=torch.float32)
            gy_d, gx_d = torch.meshgrid(y_d, x_d, indexing="ij")
            r2 = gx_d ** 2 + gy_d ** 2
            f_dist = 1.0 + lens_distortion * r2
            grid_d = torch.stack([gx_d * f_dist, gy_d * f_dist], dim=-1).unsqueeze(0).repeat(B, 1, 1, 1)
            img = F.grid_sample(img.permute(0, 3, 1, 2), grid_d, mode="bilinear", padding_mode="reflection", align_corners=False).permute(0, 2, 3, 1)
            if depth_mask is not None:
                depth_mask = F.grid_sample(depth_mask.permute(0, 3, 1, 2), grid_d, mode="bilinear", padding_mode="reflection", align_corners=False).permute(0, 2, 3, 1)

        # -------------------------------------------------------------
        # STEP 3: Frequency Separation Retouch (True Texture Locking)
        # -------------------------------------------------------------
        if enable_frequency_retouch and (skin_smooth > 0.001 or abs(clarity) > 0.001):
            x_bchw = img.permute(0, 3, 1, 2)
            low_f = self._gaussian_blur(x_bchw, smooth_radius)
            high_f = x_bchw - low_f

            # Smooth low frequencies (tone, splotchiness, blotches)
            smoothed_low = self._gaussian_blur(low_f, smooth_radius * 2)
            tone_base = torch.lerp(low_f, smoothed_low, skin_smooth)

            # High frequency texture crispness / micro-contrast
            detail = high_f * (1.0 + clarity)
            smoothed = torch.clamp(tone_base + detail, 0.0, 1.0).permute(0, 2, 3, 1)

            if active_mask is not None:
                m_ret = active_mask.permute(0, 2, 3, 1)
                img = torch.lerp(img, smoothed, m_ret)
            else:
                img = smoothed

        # -------------------------------------------------------------
        # STEP 4: Subsurface Scattering (Subdermal Skin Bleed)
        # -------------------------------------------------------------
        if enable_sss and sss_amount > 0.001:
            x_bchw = img.permute(0, 3, 1, 2)
            luma = 0.2126 * x_bchw[:, 0:1] + 0.7152 * x_bchw[:, 1:2] + 0.0722 * x_bchw[:, 2:3]

            diffused_luma = self._gaussian_blur(luma, sss_radius)
            # Find transition boundary between light and shadow (terminator lines)
            terminator = torch.clamp(diffused_luma - luma, 0.0, 1.0) * torch.sigmoid(luma * 8.0)

            sss_tint = torch.tensor([sss_tint_r, sss_tint_g, sss_tint_b], device=device, dtype=torch.float32).view(1, 3, 1, 1)
            sss_glow = terminator.repeat(1, 3, 1, 1) * sss_tint * (sss_amount * 1.5)

            if active_mask is not None:
                sss_glow = sss_glow * active_mask

            img = torch.clamp((x_bchw + sss_glow).permute(0, 2, 3, 1), 0.0, 1.0)


        # -------------------------------------------------------------
        # STEP 5: Studio Relighting (3D Depth-Aware or 2D Radial Inverse-Square Falloff)
        # -------------------------------------------------------------
        if enable_relighting and abs(light_intensity) > 0.01:
            y = torch.linspace(0.0, 1.0, H, device=device, dtype=torch.float32)
            x = torch.linspace(0.0, 1.0, W, device=device, dtype=torch.float32)
            grid_y, grid_x = torch.meshgrid(y, x, indexing="ij")
            grid_y = grid_y.view(1, H, W, 1)
            grid_x = grid_x.view(1, H, W, 1)

            if relight_use_depth and depth_mask is not None:
                dz = (depth_mask - light_z) * 1.5
                dist = torch.sqrt((grid_x - light_x) ** 2 + (grid_y - light_y) ** 2 + dz ** 2)
            else:
                dist = torch.sqrt((grid_x - light_x) ** 2 + (grid_y - light_y) ** 2)

            falloff = torch.pow(torch.clamp(1.0 - (dist / max(light_radius, 1e-4)), 0.0, 1.0), 2.2)
            ev_shift = torch.pow(2.0, falloff * light_intensity)
            color = torch.tensor([light_color_r, light_color_g, light_color_b], device=device, dtype=torch.float32).view(1, 1, 1, 3)
            tint_mix = torch.lerp(torch.ones_like(color), color, torch.clamp(torch.abs(falloff * light_intensity), 0.0, 1.0))
            img = img * ev_shift * tint_mix

        # -------------------------------------------------------------
        # STEP 6: 3D .cube LUT Engine
        # -------------------------------------------------------------
        if enable_lut and lut_file != "None" and lut_strength > 0.001:
            lut_path = folder_paths.get_full_path("luts", lut_file)
            if lut_path and os.path.exists(lut_path):
                lut_3d = self._load_cube_lut(lut_path, device)
                lut_out = self._apply_3d_lut(torch.clamp(img, 0.0, 1.0).permute(0, 3, 1, 2), lut_3d).permute(0, 2, 3, 1)
                img = torch.lerp(img, torch.clamp(lut_out, 0.0, 1.0), lut_strength)

        # -------------------------------------------------------------
        # STEP 7: Film Stock Profiles
        # -------------------------------------------------------------
        if enable_film_stock and film_stock != "None" and stock_mix > 0.001:
            img_c = torch.clamp(img, 0.0, 1.0)
            r, g, b = img_c[..., 0], img_c[..., 1], img_c[..., 2]
            if film_stock == "Kodak Portra 400":
                graded = torch.stack([torch.pow(r, 0.94) * 1.03, torch.pow(g, 0.98) * 0.99, torch.pow(b, 1.04) * 0.95], dim=-1)
            elif film_stock == "Kodak Tri-X 400 (B&W)":
                gray = (0.25 * r + 0.60 * g + 0.15 * b - 0.5) * 1.35 + 0.5
                graded = torch.clamp(gray, 0.0, 1.0).unsqueeze(-1).repeat(1, 1, 1, 3)
            elif film_stock == "Kodak CineStill 800T":
                graded = torch.stack([torch.pow(r, 1.05) * 0.97, torch.pow(g, 0.98) * 1.02, torch.pow(b, 0.88) * 1.12], dim=-1)
            elif film_stock == "Fuji Pro 400H":
                graded = torch.stack([torch.pow(r, 0.98) * 0.98, torch.pow(g, 0.92) * 1.04, torch.pow(b, 0.95) * 1.02], dim=-1)
            elif film_stock == "Kodachrome 64":
                temp = torch.stack([(r - 0.5) * 1.25 + 0.52, (g - 0.5) * 1.20 + 0.49, (b - 0.5) * 1.15 + 0.50], dim=-1)
                l = (0.299 * temp[..., 0] + 0.587 * temp[..., 1] + 0.114 * temp[..., 2]).unsqueeze(-1)
                graded = torch.lerp(l, temp, 1.22)
            else:
                graded = img_c
            img = torch.lerp(img, torch.clamp(graded, 0.0, 1.0), stock_mix)

        # -------------------------------------------------------------
        # STEP 8: Manual Color Grade & Tone
        # -------------------------------------------------------------
        if enable_color_grade:
            if exposure != 0.0:
                img = img * (2.0 ** exposure)

            if temperature != 0.0 or tint != 0.0:
                r_gain = 1.0 + (temperature * 0.18) + (tint * 0.08)
                g_gain = 1.0 - (tint * 0.14)
                b_gain = 1.0 - (temperature * 0.18) + (tint * 0.08)
                luma_p = (0.2126 * r_gain + 0.7152 * g_gain + 0.0722 * b_gain)
                r_gain /= luma_p
                g_gain /= luma_p
                b_gain /= luma_p
                wb_gain = torch.tensor([r_gain, g_gain, b_gain], device=device, dtype=torch.float32).view(1, 1, 1, 3)
                img = torch.clamp(img * wb_gain, 0.0, 1.0)

            if contrast != 1.0:
                img = (img - 0.5) * contrast + 0.5

            if saturation != 1.0:
                gry = (0.2126 * img[..., 0:1] + 0.7152 * img[..., 1:2] + 0.0722 * img[..., 2:3])
                img = torch.lerp(gry, img, saturation)

        # -------------------------------------------------------------
        # STEP 9: Filmic Highlight Shoulder Rolloff & Burnout
        # -------------------------------------------------------------
        if enable_shoulder and shoulder_start < 0.99:
            above = torch.clamp(img - shoulder_start, min=0.0)
            comp = (1.0 - shoulder_start) * torch.tanh(above / max(1e-4, (1.0 - shoulder_start) * rolloff_softness))
            img = torch.where(img > shoulder_start, shoulder_start + comp, img)
            if highlight_desat > 0.0:
                luma_s = (0.2126 * img[..., 0:1] + 0.7152 * img[..., 1:2] + 0.0722 * img[..., 2:3])
                burn = torch.pow(torch.clamp((luma_s - shoulder_start) / (1.0 - shoulder_start + 1e-4), 0.0, 1.0), 1.5) * highlight_desat
                img = torch.lerp(img, luma_s.repeat(1, 1, 1, 3), burn)

        img = torch.clamp(img, 0.0, 1.0)

        # -------------------------------------------------------------
        # STEP 10: Optical Depth of Field (True Circular Disc Bokeh)
        # -------------------------------------------------------------
        if enable_dof:
            f_stop_map = {
                "f/1.2": {"intensity": 0.85, "radius": 0.06},
                "f/1.4": {"intensity": 0.65, "radius": 0.10},
                "f/1.8": {"intensity": 0.50, "radius": 0.15},
                "f/2.0": {"intensity": 0.40, "radius": 0.20},
                "f/2.8": {"intensity": 0.30, "radius": 0.30},
                "f/4.0": {"intensity": 0.20, "radius": 0.45},
                "f/5.6": {"intensity": 0.10, "radius": 0.60},
                "f/8.0": {"intensity": 0.05, "radius": 0.75},
                "f/11":  {"intensity": 0.02, "radius": 0.85},
                "f/16":  {"intensity": 0.00, "radius": 1.00},
                "f/22":  {"intensity": 0.00, "radius": 1.00},
            }
            if f_stop in f_stop_map and f_stop != "Manual":
                eff_intensity = f_stop_map[f_stop]["intensity"]
                eff_radius = f_stop_map[f_stop]["radius"]
            else:
                eff_intensity = dof_intensity
                eff_radius = dof_sharpness_radius

            if eff_intensity > 0.01:
                if dof_use_depth and depth_mask is not None:
                    d_src = depth_mask
                else:
                    d_src = torch.linspace(0.0, 1.0, H, device=device, dtype=torch.float32).view(1, H, 1, 1).repeat(B, 1, W, 1)

                if dof_auto_focus and dof_use_depth and depth_mask is not None:
                    h_s, h_e = int(H * 0.2), int(H * 0.8)
                    w_s, w_e = int(W * 0.2), int(W * 0.8)
                    roi = d_src[:, h_s:h_e, w_s:w_e, :].reshape(B, -1)
                    target_focus = torch.quantile(roi, 0.12, dim=1).view(B, 1, 1, 1)
                else:
                    target_focus = dof_focus_point

                # Circular Disc Bokeh Convolution Kernel
                k_rad = min(28, max(2, int(eff_intensity * 28.0)))
                k_size = k_rad * 2 + 1
                y_k, x_k = torch.meshgrid(torch.arange(-k_rad, k_rad + 1, device=device), torch.arange(-k_rad, k_rad + 1, device=device), indexing="ij")
                disc = (x_k ** 2 + y_k ** 2 <= k_rad ** 2).float()
                kernel = (disc / (disc.sum() + 1e-6)).view(1, 1, k_size, k_size).repeat(3, 1, 1, 1)

                blurred = F.conv2d(img.permute(0, 3, 1, 2), kernel, padding=k_rad, groups=3).permute(0, 2, 3, 1)

                dist_focus = torch.abs(d_src - target_focus)
                blur_mask = torch.clamp((dist_focus - eff_radius) * 4.5, 0.0, 1.0)
                img = torch.lerp(img, blurred, blur_mask)

        # -------------------------------------------------------------
        # STEP 11: Atmospheric Aerial Haze & Silhouette Light Wrap
        # -------------------------------------------------------------
        if enable_atmosphere and (haze_strength > 0.01 or light_wrap_strength > 0.01):
            if depth_mask is not None:
                d_src = depth_mask
            else:
                d_src = torch.linspace(0.0, 1.0, H, device=device, dtype=torch.float32).view(1, H, 1, 1).repeat(B, 1, W, 1)

            # Rayleigh scattering atmospheric depth haze
            if haze_strength > 0.01:
                atmos_color = torch.tensor([haze_color_r, haze_color_g, haze_color_b], device=device, dtype=torch.float32).view(1, 1, 1, 3)
                if haze_use_depth:
                    atmos_mask = torch.pow(d_src, 1.4) * haze_strength
                else:
                    atmos_mask = torch.full_like(d_src, haze_strength * 0.5)
                img = torch.lerp(img, atmos_color, atmos_mask * lift_blacks)
                luma_gray = 0.2126 * img[..., 0:1] + 0.7152 * img[..., 1:2] + 0.0722 * img[..., 2:3]
                img = torch.lerp(img, luma_gray.repeat(1, 1, 1, 3), atmos_mask * 0.35)

            # Silhouette Light Wrap (Background bloom bleeding around foreground edges)
            if light_wrap_strength > 0.01:
                img_bchw = img.permute(0, 3, 1, 2)
                bloom = F.avg_pool2d(img_bchw, kernel_size=21, stride=1, padding=10).permute(0, 2, 3, 1)
                if light_wrap_use_depth:
                    near_mask = 1.0 - d_src
                else:
                    near_mask = torch.full_like(d_src, 0.5)
                screen_wrap = 1.0 - (1.0 - img) * (1.0 - torch.clamp(bloom * light_wrap_strength, 0.0, 0.95))
                img = torch.lerp(img, screen_wrap, near_mask * 0.40)

        # -------------------------------------------------------------
        # STEP 12: Optical Mist Diffusion (Pro-Mist)
        # -------------------------------------------------------------
        if enable_mist and mist_intensity > 0.001:
            x_bchw = img.permute(0, 3, 1, 2)
            luma_m = 0.2126 * x_bchw[:, 0:1] + 0.7152 * x_bchw[:, 1:2] + 0.0722 * x_bchw[:, 2:3]
            m_gate = torch.pow(torch.clamp((luma_m - mist_cutoff) / (1.0 - mist_cutoff + 1e-4), 0.0, 1.0), 1.5)
            m_src = x_bchw * m_gate

            b_in = self._gaussian_blur(m_src, max(3, mist_radius // 4))
            b_mid = self._gaussian_blur(m_src, max(5, mist_radius // 2))
            b_out = self._gaussian_blur(m_src, mist_radius)
            bloom = (b_in * 0.50 + b_mid * 0.32 + b_out * 0.18) * mist_intensity

            if mist_type == "Black Pro-Mist":
                bloom = bloom * torch.sigmoid((luma_m - 0.12) * 15.0)

            img = torch.clamp((x_bchw + bloom).permute(0, 2, 3, 1), 0.0, 1.0)

        # -------------------------------------------------------------
        # STEP 11: Anamorphic Horizontal Flare
        # -------------------------------------------------------------
        if enable_flare and anamorphic_flare > 0.001:
            x_bchw = img.permute(0, 3, 1, 2)
            luma_a = 0.2126 * x_bchw[:, 0:1] + 0.7152 * x_bchw[:, 1:2] + 0.0722 * x_bchw[:, 2:3]
            flare_src = torch.pow(torch.clamp((luma_a - 0.85) / 0.15, 0.0, 1.0), 3.0)

            streak = flare_src
            kw = min(W if W % 2 != 0 else W - 1, 65)
            if kw >= 3:
                for _ in range(3):
                    streak = F.avg_pool2d(streak, kernel_size=(1, kw), stride=1, padding=(0, kw // 2))

            tint_a = torch.tensor([0.15, 0.45, 1.0], device=device, dtype=torch.float32).view(1, 3, 1, 1)
            f_sig = streak.repeat(1, 3, 1, 1) * tint_a * (anamorphic_flare * 2.5)
            comp_a = 1.0 - (1.0 - x_bchw) * (1.0 - torch.clamp(f_sig, 0.0, 0.95))
            img = comp_a.permute(0, 2, 3, 1)

        # -------------------------------------------------------------
        # STEP 12: Multi-Spectral Layered Halation
        # -------------------------------------------------------------
        if enable_halation and halation_intensity > 0.001:
            x_bchw = img.permute(0, 3, 1, 2)
            luma_h = 0.2126 * x_bchw[:, 0:1] + 0.7152 * x_bchw[:, 1:2] + 0.0722 * x_bchw[:, 2:3]
            spec = torch.pow(torch.clamp((luma_h - (halation_threshold - 0.15)) / 0.3, 0.0, 1.0), 2.5) * x_bchw
            bg_luma = self._gaussian_blur(luma_h, halation_spread * 2)
            edge_gate = torch.clamp(1.0 - bg_luma * 0.75, 0.1, 1.0)

            r_tight = self._gaussian_blur(spec[:, 0:1], max(3, halation_spread // 2))
            r_wide = self._gaussian_blur(spec[:, 0:1], halation_spread)
            r_glow = (r_tight * 0.6 + r_wide * 0.7) * 1.2
            g_glow = self._gaussian_blur(spec[:, 1:2], max(3, int(halation_spread * 0.4))) * (halation_amber_core * 0.55)
            b_glow = torch.zeros_like(r_glow)

            h_sig = torch.cat([r_glow, g_glow, b_glow], dim=1) * edge_gate * halation_intensity
            comp = 1.0 - (1.0 - x_bchw) * (1.0 - torch.clamp(h_sig, 0.0, 0.95))
            img = torch.clamp(comp.permute(0, 2, 3, 1), 0.0, 1.0)

        # -------------------------------------------------------------
        # STEP 13: Lateral Chromatic Aberration
        # -------------------------------------------------------------
        if enable_lateral_ca and abs(lateral_ca) > 0.0001:
            x_bchw = img.permute(0, 3, 1, 2)
            y_c = torch.linspace(-1.0, 1.0, H, device=device, dtype=torch.float32)
            x_c = torch.linspace(-1.0, 1.0, W, device=device, dtype=torch.float32)
            gy, gx = torch.meshgrid(y_c, x_c, indexing="ij")
            r_val = torch.sqrt(gx ** 2 + gy ** 2)
            disp = lateral_ca * (r_val + 0.5 * (r_val ** 3))

            g_red = torch.stack([gx * (1.0 + disp), gy * (1.0 + disp)], dim=-1).unsqueeze(0).repeat(B, 1, 1, 1)
            g_blue = torch.stack([gx * (1.0 - disp), gy * (1.0 - disp)], dim=-1).unsqueeze(0).repeat(B, 1, 1, 1)

            r_ch = F.grid_sample(x_bchw[:, 0:1], g_red, mode="bilinear", padding_mode="border", align_corners=False)
            b_ch = F.grid_sample(x_bchw[:, 2:3], g_blue, mode="bilinear", padding_mode="border", align_corners=False)
            img = torch.cat([r_ch, x_bchw[:, 1:2], b_ch], dim=1).permute(0, 2, 3, 1)

        # -------------------------------------------------------------
        # STEP 14: cos^4 Natural Optical Vignette
        # -------------------------------------------------------------
        if enable_vignette and vignette_amount > 0.001:
            y_v = torch.linspace(-1.0, 1.0, H, device=device, dtype=torch.float32)
            x_v = torch.linspace(-1.0, 1.0, W, device=device, dtype=torch.float32)
            gy_v, gx_v = torch.meshgrid(y_v, x_v, indexing="ij")
            r_v = torch.sqrt(gx_v ** 2 + gy_v ** 2) / 1.4142
            cos_t = torch.clamp(1.0 - 0.5 * (r_v ** 2), 0.0, 1.0)
            v_mask = torch.pow(cos_t, 4.0).unsqueeze(0).unsqueeze(-1)
            img = img * torch.lerp(torch.ones_like(v_mask), v_mask, vignette_amount * 0.75)

        # -------------------------------------------------------------
        # STEP 15: Photochemical Zonal Silver Halide Grain (Pure Neutral Grain)
        # -------------------------------------------------------------
        if enable_grain and grain_amount > 0.001:
            gen = torch.Generator(device=device).manual_seed(grain_seed)
            luma_g = 0.2126 * img[..., 0:1] + 0.7152 * img[..., 1:2] + 0.0722 * img[..., 2:3]
            mid_m = torch.exp(-torch.pow(luma_g - 0.48, 2.0) / 0.06)
            shd_m = torch.exp(-torch.pow(luma_g - 0.15, 2.0) / 0.05) * (1.0 - torch.sigmoid((luma_g - 0.40) * 12.0))
            hil_m = torch.sigmoid((luma_g - 0.62) * 10.0)
            density = (shd_m * grain_shadows) + (mid_m * grain_midtones) + (hil_m * grain_highlights)

            # Natural boundary taper to prevent clipping at true black (0.0) and blown white (1.0)
            boundary_taper = torch.clamp(luma_g * (1.0 - luma_g) * 4.0, 0.0, 1.0)
            density = density * torch.sqrt(boundary_taper)

            gh = max(2, int(float(H) / max(0.2, grain_size)))
            gw = max(2, int(float(W) / max(0.2, grain_size)))
            mono = F.interpolate(torch.randn((B, 1, gh, gw), generator=gen, device=device), size=(H, W), mode="bilinear", align_corners=False)
            mono = mono / (mono.std() + 1e-6)

            if grain_color > 0.001:
                cmy = F.interpolate(torch.randn((B, 3, gh, gw), generator=gen, device=device), size=(H, W), mode="bilinear", align_corners=False)
                cmy = cmy / (cmy.std() + 1e-6)
                noise = torch.lerp(mono.repeat(1, 3, 1, 1), cmy, grain_color * 0.5).permute(0, 2, 3, 1)
            else:
                noise = mono.permute(0, 2, 3, 1)  # [B, H, W, 1] broadcast to RGB identically (Zero color cast)

            # Pure additive zero-mean grain: zero shift in average color, tone, or hue
            grain_signal = noise * density * (grain_amount * 0.06)
            img = torch.clamp(img + grain_signal, 0.0, 1.0)

        # Mask Target Scope: All Effects confines everything to the active mask
        if active_mask is not None and mask_scope == "All Effects":
            m_4d = active_mask[:B].permute(0, 2, 3, 1)  # [B, H, W, 1]
            img = torch.lerp(orig_img, img, m_4d)

        img = img[:B]
        # Ensure return tensors are back on CPU and clamped [0, 1]
        if depth_mask is not None:
            depth_out = depth_mask[:B].repeat(1, 1, 1, 3).cpu().contiguous()
        else:
            depth_out = torch.full((B, H, W, 3), 0.5, dtype=torch.float32)

        if active_mask is not None:
            mask_out = active_mask[:B].permute(0, 2, 3, 1).repeat(1, 1, 1, 3).clamp(0.0, 1.0).cpu().contiguous()
        else:
            mask_out = torch.zeros((B, H, W, 3), dtype=torch.float32)

        return (img.cpu().contiguous(), depth_out, mask_out)

