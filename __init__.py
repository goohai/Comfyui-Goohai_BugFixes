WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}


def _empty(value):
    return value is None or str(value).strip().lower() in {"", "none", "null", "无"}


def _missing_image(value):
    if _empty(value):
        return True
    try:
        import folder_paths
        return not folder_paths.exists_annotated_filepath(str(value))
    except Exception:
        return False


def _image_input(node_class):
    try:
        inputs = node_class.INPUT_TYPES()
    except Exception:
        return None
    for section in (inputs.get("required", {}), inputs.get("optional", {})):
        for name, spec in section.items():
            options = spec[1] if isinstance(spec, (tuple, list)) and len(spec) > 1 else spec
            if isinstance(options, dict) and (options.get("image_upload") or options.get("animated_image_upload")):
                return name
    return None


def _empty_outputs(node_class):
    return tuple(None for _ in getattr(node_class, "RETURN_TYPES", ()))


def _patch_image_loaders():
    try:
        import nodes
    except Exception:
        return

    def _patch_image_loader(node_class):
        if not isinstance(node_class, type) or getattr(node_class, "_goohai_empty_image_loader", False):
            return
        image_input = _image_input(node_class)
        if not image_input:
            return
        original_validate = getattr(node_class, "VALIDATE_INPUTS", None)
        if original_validate:
            @classmethod
            def validate_inputs(cls, _image_input=image_input, _original_validate=original_validate, **kwargs):
                return True if _missing_image(kwargs.get(_image_input)) else _original_validate(**kwargs)
            node_class.VALIDATE_INPUTS = validate_inputs
        function_name = getattr(node_class, "FUNCTION", None)
        original_function = getattr(node_class, function_name, None)
        if original_function:
            def safe_function(self, *args, _node_class=node_class, _image_input=image_input, _original_function=original_function, **kwargs):
                value = kwargs.get(_image_input)
                if value is None:
                    try:
                        value = args[list(_node_class.INPUT_TYPES().get("required", {})).index(_image_input)]
                    except (ValueError, IndexError):
                        pass
                return _empty_outputs(_node_class) if _missing_image(value) else _original_function(self, *args, **kwargs)
            setattr(node_class, function_name, safe_function)
        original_changed = getattr(node_class, "IS_CHANGED", None)
        if original_changed:
            @classmethod
            def is_changed(cls, _image_input=image_input, _original_changed=original_changed, **kwargs):
                return "empty" if _missing_image(kwargs.get(_image_input)) else _original_changed(**kwargs)
            node_class.IS_CHANGED = is_changed
        node_class._goohai_empty_image_loader = True

    for node_class in set(nodes.NODE_CLASS_MAPPINGS.values()):
        _patch_image_loader(node_class)

    # Custom nodes are imported after this extension in some installations.
    # Patch their image loaders lazily when ComfyUI validates a prompt.
    try:
        import execution
    except Exception:
        return
    original_validate_prompt_node = execution.validate_inputs
    if getattr(original_validate_prompt_node, "_goohai_image_loader_hook", False):
        return

    async def validate_inputs_with_image_loader_patch(prompt_id, prompt, item, validated, visiting=None):
        node_data = prompt.get(item, {})
        class_type = node_data.get("class_type")
        node_class = getattr(nodes, "NODE_CLASS_MAPPINGS", {}).get(class_type)
        if isinstance(node_class, type):
            _patch_image_loader(node_class)
        return await original_validate_prompt_node(prompt_id, prompt, item, validated, visiting)

    validate_inputs_with_image_loader_patch._goohai_image_loader_hook = True
    execution.validate_inputs = validate_inputs_with_image_loader_patch


_patch_image_loaders()

__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]
