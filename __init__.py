"""
ComfyUI Visual Slot Reorder - Nodes 2 Compat.

Frontend-only extension package for ComfyUI Registry / ComfyUI Manager.
It does not register backend Python nodes; it only exposes the frontend
extension files through WEB_DIRECTORY.
"""

WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = [
    "WEB_DIRECTORY",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
