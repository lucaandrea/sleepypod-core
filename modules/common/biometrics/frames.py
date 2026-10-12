"""Shared little-endian firmware sample decoding and lost-marker repair."""
import numpy as np


LOST_SAMPLE = np.iinfo(np.int32).max


def decode_int32_samples(buf) -> np.ndarray:
    """Decode an int32 sample buffer, tolerating truncated tails and
    repairing lost-sample markers.

    A RAW record cut mid-write can carry a payload whose length is not a
    multiple of 4; np.frombuffer would raise ValueError and kill the module.
    Truncate to whole samples instead. A LOST_SAMPLE marker is replaced by
    linear interpolation between its neighbours (the nearest valid sample at
    a record edge); a record with no valid sample decodes as empty.
    """
    if not isinstance(buf, (bytes, bytearray, memoryview)):
        return np.empty(0, dtype=np.dtype("<i4"))
    usable = len(buf) - (len(buf) % 4)
    if usable == 0:
        return np.empty(0, dtype=np.dtype("<i4"))
    samples = np.frombuffer(buf[:usable], dtype=np.dtype("<i4"))
    lost = samples == LOST_SAMPLE
    if not lost.any():
        return samples
    if lost.all():
        return np.empty(0, dtype=np.dtype("<i4"))
    idx = np.arange(samples.size)
    repaired = samples.astype(np.float64)
    repaired[lost] = np.interp(idx[lost], idx[~lost], repaired[~lost])
    return np.round(repaired).astype(np.int32)

