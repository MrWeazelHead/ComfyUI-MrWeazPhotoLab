"""
@author: MrWeaz
@title: MrWeaz - PhotoLab
@nickname: MrWeaz - PhotoLab
@description: Unified Virtual Darkroom, Optical Bench & Diffusion Retouch Suite
"""
import os
from .py.photolab_master import PhotoLabMasterSuite

PhotoLabMasterSuite.RELATIVE_PYTHON_MODULE = "custom_nodes.ComfyUI-MrWeazPhotoLab"

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "PhotoLabMasterSuite": PhotoLabMasterSuite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PhotoLabMasterSuite": "MrWeaz - PhotoLab",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

