"""Read the shipped contract; never write measured sensor calibration.

finite-binary64-json-v1 encodes exact decimal expansions of IEEE-754 values.
Unlike language-specific JSON float printers, this gives identical bytes on
both runtimes, including subnormals and negative zero. Object keys use UTF-16
ordering (the JavaScript ordering); arrays retain their meaningful order.
"""
import copy
import hashlib
import json
import math
from pathlib import Path

_MANIFEST = json.loads(Path(__file__).with_name("manifest.v1.json").read_text())


def canonical_json(value):
    nodes = 0

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 20000 or depth > 32:
            raise ValueError("JSON resource limit")
        if item is None:
            return "null"
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, (int, float)):
            number = float(item)
            if not math.isfinite(number):
                raise ValueError("Non-finite JSON number")
            if number == 0:
                return "0"
            numerator, denominator = abs(number).as_integer_ratio()
            places = denominator.bit_length() - 1
            digits = str(numerator * 5 ** places)
            if places:
                digits = digits.zfill(places + 1)
                digits = (digits[:-places] + "." + digits[-places:]).rstrip("0").rstrip(".")
            return ("-" if number < 0 else "") + digits
        if isinstance(item, str):
            try:
                length = len(item.encode("utf-16-be")) // 2
            except UnicodeEncodeError as error:
                raise ValueError("Invalid JSON string") from error
            if length > 65536:
                raise ValueError("Invalid JSON string")
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, list):
            return "[" + ",".join(visit(child, depth + 1) for child in item) + "]"
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError("Expected string keys")
            try:
                keys = sorted(item, key=lambda key: key.encode("utf-16-be"))
            except UnicodeEncodeError as error:
                raise ValueError("Invalid JSON string") from error
            return "{" + ",".join(visit(key, depth + 1) + ":" + visit(item[key], depth + 1)
                                  for key in keys) + "}"
        raise ValueError("Expected finite JSON data")

    return visit(value, 0)


def config_hash(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def manifest():
    return copy.deepcopy(_MANIFEST)


def _validate(schema, value, path):
    def fail():
        raise ValueError("Invalid biometric parameter: " + path)
    if "const" in schema and value != schema["const"]:
        fail()
    if "enum" in schema and value not in schema["enum"]:
        fail()
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            fail()
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            fail()
        for key, child in value.items():
            if key not in properties:
                fail()
            _validate(properties[key], child, path + "." + key)
    elif kind == "array":
        if not isinstance(value, list) or len(value) > schema.get("maxItems", math.inf):
            fail()
        for child in value:
            _validate(schema["items"], child, path)
    elif kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            fail()
        if not math.isfinite(value):
            fail()
        if kind == "integer" and (value != int(value) or abs(value) > 9007199254740991):
            fail()
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            fail()
    elif kind == "string":
        if not isinstance(value, str):
            fail()
    elif kind == "boolean":
        if not isinstance(value, bool):
            fail()
    else:
        raise ValueError("Unsupported contract schema: " + path)


def validate_config(value):
    canonical_json(value)
    _validate(_MANIFEST["parameters"], value, "config")
    for path in _MANIFEST["orderedRanges"]:
        node = value
        for key in path:
            node = node[key]
        if node["min"] > node["max"]:
            raise ValueError("Invalid ordered range: " + ".".join(path))
    return value


def resolve_config(overrides, base_hash=None):
    expected = config_hash(_MANIFEST)
    if base_hash is not None and base_hash != expected:
        raise ValueError("PROFILE_INCOMPATIBLE: unknown base manifest")
    if len(overrides) > 64:
        raise ValueError("RESOURCE_LIMIT: maximum 64 overrides")
    resolved = copy.deepcopy(_MANIFEST["defaults"])
    paths = set()
    for override in overrides:
        if set(override) != {"path", "value"}:
            raise ValueError("Invalid override fields")
        path = override["path"]
        if path in paths:
            raise ValueError("Duplicate override path")
        paths.add(path)
        parts = path.split(".")
        schema = _MANIFEST["parameters"]
        parent = resolved
        for index, part in enumerate(parts):
            if schema["type"] != "object" or part not in schema["properties"]:
                raise ValueError("Unknown override path: " + path)
            schema = schema["properties"][part]
            if index == len(parts) - 1:
                if schema["type"] == "object":
                    raise ValueError("Override leaves or entire ordered arrays")
                _validate(schema, override["value"], path)
                parent[part] = copy.deepcopy(override["value"])
            else:
                parent = parent[part]
    validate_config(resolved)
    return {"resolved": resolved, "hash": config_hash(resolved), "manifestHash": expected,
            "overrides": copy.deepcopy(overrides),
            "provenance": {override["path"]: "override" for override in overrides}}
