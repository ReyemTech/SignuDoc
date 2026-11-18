"""Compare Helm package members by path and content without extracting files."""

import hashlib
import sys
import tarfile


def members(path):
    contents = {}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            parts = member.name.split("/")
            if parts[0] != "signudoc" or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"Unsafe chart member path: {member.name!r}")
            if member.name in contents:
                raise ValueError(f"Duplicate chart member path: {member.name!r}")
            if member.isdir():
                contents[member.name] = ("directory", None)
            elif member.isfile():
                with archive.extractfile(member) as source:
                    contents[member.name] = ("file", hashlib.file_digest(source, "sha256").hexdigest())
            else:
                raise ValueError(f"Unsupported chart member type: {member.name!r}")
    if "signudoc/Chart.yaml" not in contents:
        raise ValueError("Chart archive is missing signudoc/Chart.yaml")
    return contents


def main(expected_path, published_path):
    try:
        expected = members(expected_path)
        published = members(published_path)
    except (EOFError, OSError, ValueError, tarfile.TarError) as error:
        sys.exit(f"Cannot verify chart archives: {error}")

    changed = sorted(
        name for name in expected.keys() | published.keys()
        if expected.get(name) != published.get(name)
    )
    if changed:
        sys.exit(f"Published chart differs at {', '.join(repr(name) for name in changed)}")


if __name__ == "__main__":
    main(*sys.argv[1:])
