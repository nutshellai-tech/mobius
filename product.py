#!/usr/bin/env python3
from __future__ import annotations

from debug import main


if __name__ == "__main__":
    raise SystemExit(
        main(
            script_name="product.py",
            description=(
                "Restart product Mobius, or compile/promote frontend only with "
                "--only-update-frontend."
            ),
            start_script_name="start_product.py",
            product_mode=True,
        )
    )
