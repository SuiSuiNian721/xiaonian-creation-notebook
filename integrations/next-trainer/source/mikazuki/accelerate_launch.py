"""Training subprocess entry: enable China hub routing, then run accelerate launch."""

from __future__ import annotations

import sys

from mikazuki.china_hub import enable_china_hub

enable_china_hub()

from accelerate.commands.launch import main  # noqa: E402


if __name__ == "__main__":
    sys.argv[0] = "accelerate-launch"
    main()
