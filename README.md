# ComfyUI-MrWeazPhotoLab 📸

A high-performance ComfyUI custom node suite engineered specifically for **authentic photography processing**, darkroom color science, physical optical lens bench, 3D depth-aware effects, and micro-detail neural diffusion retouching.

All capabilities are unified into a single interactive master powerhouse node: **`MrWeaz - PhotoLab`** (`PhotoLabMasterSuite`).

---

## 🌟 Interactive Darkroom & Optics Bench UI

The suite features an integrated, high-resolution darkroom console directly on the node canvas:
- **Modular Tabbed Interface**: Organized into 5 focused workspaces:
  1. `🎯 Retouch & AI`: Auto-Masking & SAM Engine, Neural inpaint (external models / checkpoints), pore-locking Frequency Separation, and Subdermal Skin Scattering (SSS).
  2. `💡 Light & Tone`: 3D Depth-Aware Studio Relighting, 3D .cube LUT engine, iconic Film Stocks, manual color grading, and filmic shoulder rolloff.
  3. `🔬 Optics Bench`: Lens distortion curvature (with 24mm, 35mm, 50mm, 85mm prime presets), Optical Depth of Field (with disc bokeh & F-stop apertures), Atmospheric Rayleigh Haze & Silhouette Light Wrap, Pro-Mist diffusion, anamorphic streak flares, multi-spectral halation, lateral chromatic aberration, and $\cos^4(\theta)$ vignetting.
  4. `🎞️ Film Grain`: Photochemical silver halide grain with sensitometric tone response, zero color cast, and 8mm, 16mm, 35mm, 120, and 4x5 format presets.
  5. `🎬 Master Looks`: 22 one-click professional cinematography and film presets across 5 aesthetic categories.
- **Collapsible Section Cards (Minimized by Default)**: All control cards are collapsed by default to save canvas space and eliminate visual clutter. Simply click any card header to expand or collapse it with smooth chevron animations (`▸` / `▾`). Use the top header `⊞ Expand All` / `⊟ Collapse All` button to instantly reveal or tuck away all controls.

---

## 🎯 Auto-Masking & SAM Prompting Engine

The node features a comprehensive automated segmentation and masking engine supporting Segment Anything (SAM):
- **Triple Output Architecture (`image`, `depth_map`, `mask`)**:
  - `image`: The final photochemically and optically processed image.
  - `depth_map`: 3D depth map (from ZoeDepth or external input) for depth-aware workflows.
  - `mask`: The active segmentation mask formatted as a standard float32 RGB `IMAGE` (`[B, H, W, 3]`). Connect directly to a ComfyUI `PreviewImage` or `SaveImage` node to visualize exactly what SAM or heuristic auto-masking is targeting!
- **Detector-Assisted SAM Prompting Engine (`sam_prompt`)**:
  - Connects natural language prompting directly to SAM using local, zero-internet detectors (`models/ultralytics/`):
    - **Face, Head & Portrait**: Uses local `face_yolov8m` to detect exact face bounding boxes, passing boxes directly to SAM (`predictor.predict(box=box)`) for razor-sharp facial isolation.
    - **Lips & Eyes**: Detects and isolates anatomical facial sub-regions.
    - **Hair**: Computes crown and lateral bounding bounds relative to the detected face and segments with SAM.
    - **Hands**: Uses local `hand_yolov8s` to detect hands and fingers.
    - **Clothes & Torso**: Uses local `yolov8n` to detect person bodies and isolates torso/clothing bounds.
    - **80 COCO Objects**: Prompts like `dog`, `cat`, `car`, `chair`, `bottle`, `cup`, `laptop`, `phone`, etc., locate matching objects via `yolov8n` and segment them with SAM.
    - **Background & Sky**: Prompts containing `background`, `backdrop`, `sky`, `wall`, or `room` detect foreground subjects and automatically invert the mask.
    - **Coordinates**: Enter normalized coordinate pairs (e.g. `0.35, 0.45`) or use the UI center sliders.
    - **Auto-Activation**: Typing any prompt in `sam_prompt` automatically activates SAM without needing to flip the mode dropdown from `Disabled`.
    - **Quick Target Chips in UI**: One-click buttons in the darkroom UI for `[👤 Subject, 😊 Face, 💇 Hair, 👄 Lips, ✋ Hands, 👕 Clothes, 🐕 Pet, 🚗 Car, 🌄 Background]`.

- **Depth-Assisted Center Snapping (`sam_depth_assist`)**: Uses local ZoeDepth to automatically locate the nearest foreground subject around the prompt coordinates—no need to manually pinpoint pixel coordinates.
- **Algorithmic Auto-Mask Modes**:
  - `Depth Foreground Isolation`: Isolates subjects using metric depth.
  - `Skin & Portrait Tones`: Segments skin tones and facial features for retouching.
  - `Specular Highlights`: Isolates high-luma glints and reflections.
  - `Shadows & Blacks`: Targets low-luma shadow regions.
- **Configurable Mask Scope**:
  - `Retouch Only`: Restricts Diffusion Inpaint and Frequency Separation to the mask, while optical/darkroom effects apply globally.
  - `All Effects`: Completely isolates **all** enabled effects (retouching, relighting, LUTs, grain, mist, flares, etc.) to the masked area. Non-masked pixels remain 100% bit-for-bit identical to the input image.
- **Empty Mask Bypass**: If a mask is provided or generated with all zeros, all processing and effects are automatically bypassed, immediately returning the untouched input image and a zero mask.
- **Mask Inversion & Feathering**: Instant 1-click mask inversion and smooth edge feathering with Gaussian blur.

---

## 🤖 Automatic 3D Depth Mapping Engine (ZoeDepth)

The node integrates local neural depth estimation powered by `Intel/zoedepth-nyu-kitti`:
- **100% Local & Private**: Runs entirely on your local machine using cached HuggingFace weights without any internet requests.
- **Plug-and-Play Zero Setup**: If no `depth_map` socket is connected, the node automatically estimates high-fidelity metric 3D depth for your image. You can also wire external depth maps (e.g., Depth Anything V2) directly into the `depth_map` socket.
- **Multi-Section Depth Integration**:
  - **Depth of Field (DoF)**: Real circular disc convolution bokeh with physical aperture presets (`f/1.2` through `f/22`) and auto-focus tracking on foreground subjects.
  - **3D Studio Relighting**: True 3D spherical inverse-square falloff $(X, Y, Z)$ where the light source can be positioned in front of or behind subjects for realistic key, fill, or rim lighting.
  - **Atmospheric Aerial Haze**: Realistic Rayleigh distance scattering that smoothly fades distant mountains and horizons while keeping foreground subjects crisp.
  - **Silhouette Light Wrap**: Edge-detected light bleeding around foreground silhouettes, hair strands, and shoulders.
- **Dedicated Outputs**: Returns both `image`, `depth_map`, and `mask` for modular compositing.

---

## 🎬 22 Curated Master Looks & Film Presets

Tab 5 provides instant one-click professional configurations across 5 curated categories with baseline resets to prevent look contamination:

### 🎬 Iconic Cinema & Directorial Looks
1. `🎬 35mm Hollywood Panavision`: Kodak Portra 400 + Dynamic Shoulder + Amber/Red Halation + 35mm Grain + Anamorphic Streak + Vignette.
2. `🌌 Blade Runner 2049 (Dystopian Amber)`: Sodium Vapor 3D Key Light + Cool Cyan Fill + Dense Volumetric Depth Haze + CineStill + Anamorphic Flare.
3. `🏜️ Dune Arrakis Spice (Villeneuve / Fraser)`: Bleached Sun Exposure + Ochre Dust Volumetric Haze + Warm Sand Relight + 65mm IMAX Scale.
4. `🛸 Kubrick 2001 (Clinical Sci-Fi)`: Cold Analytic Balance + Clinical High-Key Exposure + Razor Contrast + Clean Low Grain.
5. `🕶️ Fincher Green Tungsten (Mindhunter)`: Moody Fluorescent Olive Grade + Crushed Inky Blacks + Piercing Texture Clarity + Vignette.
6. `🩸 Dario Argento Giallo (1970s Horror)`: Saturated Crimson Gel 3D Relighting + Deep Noir Shadows + Intense Halation + Black Pro-Mist.
7. `🏎️ Wes Anderson Pastel Symmetry`: Vibrant Custard Yellow & Mint Palette + Flat Low Contrast + Soft Fog Diffusion + Crisp Geometry.

### 📸 Photochemical Film Stocks & Vintage
8. `🌃 Neo-Tokyo Cyberpunk`: CineStill 800T + Electric Cyan/Magenta Split + Intense Amber Halation + Anamorphic Streak + Pro-Mist.
9. `🎥 16mm French New Wave`: Fuji 400H + 35mm Prime Distortion + Chromatic Aberration + Gritty 16mm Silver Grain.
10. `📸 1970s Kodachrome 64`: Warm Golden Yellow/Red Color Punch + Rich Contrast + Natural Vintage Vignette + Grain.
11. `🍭 Technicolor Three-Strip (1950s)`: Vibrant Dye-Transfer Saturation + Rich Golden Glow Halation + Soft Shoulder + 35mm Grain.
12. `☕ 90s Seattle Grunge & Coffeehouse`: Warm Earthy Olive/Ochre Tones + Lifted Dynamic Toe + Portra Warmth + Intimate 35mm Grain.

### 💄 Portrait, Studio & High-End Editorial
13. `💄 Vogue High-Fashion Editorial`: Pore-Locking Retouch + SSS Red Bleed + 3D Key/Rim Light + Soft Shoulder Rolloff + Crisp Grain.
14. `🌅 Golden Hour Nat-Geo`: Warm Sun Rim Light + Atmospheric Depth Rayleigh Haze + Light Wrap + f/2.0 Disc Bokeh.
15. `💎 Modern A24 Drama`: Pristine Kodak Portra 400 + Natural Organic Relight + Shallow f/1.8 Bokeh + True Filmic Curve.
16. `⚡ Euphoria Neon Drench (A24 / HBO)`: Dual Violet/Cyan Color Split + Specular Amber Halation + Heavy Pro-Mist + Film Dynamic Range.

### 🎞️ Black & White Fine Art & Street
17. `🎞️ Tri-X 400 Noir (Silver Gelatin)`: Monochrome Street Photography + Crushed Inky Blacks + Sharp Micro-Contrast + Tactile Grain.
18. `🏛️ Fine Art Platinum / Palladium`: Smooth Sepia-Toned Platinum Print + Wide Dynamic Shoulder + Delicate Medium Format Grain.
19. `🌊 Nordic Melancholy (Scandi Noir)`: Desaturated Steel-Blue Tone + Overcast Fog Haze + Crisp Micro-Pore Texture + Subtle Lateral CA.

### 🌸 Atmospheric, Dreamcore & Passthrough
20. `🌸 Pastel Japanese Indie`: Fuji 400H + Milky Lifted Shadows + Soft White Fog Mist + High Key Exposure + Gentle Grain.
21. `✨ Dreamcore 90s Nostalgia`: Lush White Fog Bloom + Chromatic Edge Fringing + Pastel Lifted Blacks + Anamorphic Streaks.
22. `⚪ Ultra Clean Passthrough`: Turn all processing modules OFF for pure unadjusted canvas reference.

---

## 🚀 Installation & Setup

1. Place this repository into your ComfyUI `custom_nodes` directory:
   ```bash
   custom_nodes/ComfyUI-MrWeazPhotoPro/
   ```
2. Place any `.cube` LUT files into `models/luts/` (created automatically).
3. In ComfyUI, add node: **`MrWeaz - PhotoLab`** (under category `MrWeazNodes/PhotoLab`).
