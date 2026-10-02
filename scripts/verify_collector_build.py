"""Fail closed on native build results and prepare exact two-platform manifest inputs."""

import argparse
import pathlib
import re
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True)
    parser.add_argument("--digests", type=pathlib.Path)
    parser.add_argument("--image")
    args = parser.parse_args()

    if args.result != "success":
        parser.error("Both native architecture builds must succeed before release")
    if args.digests is None:
        return 0
    if not args.image or not re.fullmatch(r"ghcr\.io/[a-z0-9_-]+/ercot-collector", args.image):
        parser.error("A valid collector image name is required for manifest assembly")

    sources = []
    for arch in ("amd64", "arm64"):
        try:
            digest = (args.digests / f"{arch}.txt").read_text().strip()
        except OSError as error:
            parser.error(f"Missing {arch} collector digest: {error}")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            parser.error(f"Invalid {arch} collector digest")
        sources.append(f"{args.image}@{digest}")

    # Never emit partial manifest inputs if either architecture is absent or malformed.
    print("\n".join(sources))
    return 0


if __name__ == "__main__":
    sys.exit(main())
