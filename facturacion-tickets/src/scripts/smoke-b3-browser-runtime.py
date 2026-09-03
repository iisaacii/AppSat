import asyncio
import os

from browser_use import Browser
from browser_use.browser.profile import BrowserProfile


async def main() -> None:
    executable_path = os.getenv("B3_BROWSER_EXECUTABLE_PATH", "").strip() or None
    profile = BrowserProfile(
        headless=True,
        executable_path=executable_path,
        args=["--disable-dev-shm-usage"],
        chromium_sandbox=False,
        enable_default_extensions=False,
    )
    browser = Browser(browser_profile=profile)

    try:
        await browser.start()
        print("B3_CLOUD_BROWSER_OK")
    finally:
        await browser.stop()


if __name__ == "__main__":
    asyncio.run(main())
