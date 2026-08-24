import os


class Storage:
    def __init__(self, root: str) -> None:
        self.root = os.path.realpath(root)

    def resolve(self, key: str) -> str:
        full = os.path.realpath(os.path.join(self.root, key))
        rel = os.path.relpath(full, self.root)
        if rel == "." or rel.startswith("..") or os.path.isabs(rel):
            raise ValueError(f"invalid storage key: {key!r}")
        return full

    def normalized_key(self, meeting_id: str) -> str:
        return f"meetings/{meeting_id}/normalized.flac"

    def exists(self, key: str) -> bool:
        return os.path.isfile(self.resolve(key))
