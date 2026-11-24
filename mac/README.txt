KAIROS FOR MAC
==============

Kairos runs quietly in the background on your Mac, with a window and a menu bar icon.
No admin password needed. Works on Apple Silicon and Intel Macs, macOS 12 or newer.

INSTALL OR UPDATE (about 5 minutes the first time)
1. Open Terminal (press Cmd + Space, type "Terminal", press Enter).
2. Paste this line and press Enter:

       curl -fsSL https://github.com/__REPO__/releases/latest/download/install.sh | bash

Kairos opens when it is ready. After that, open it any time from Applications -> Kairos
or Launchpad. Run the same line again to update.

Already downloaded Kairos-mac.tar.gz? Double-click it, then in Terminal type "bash " and drag
install.sh from the unzipped folder into the Terminal window, and press Enter.

WHY TERMINAL?
Kairos isn't signed with an Apple Developer certificate, so macOS blocks it when a browser
downloads it. Files fetched by Terminal aren't flagged that way, so Kairos opens normally.

GOOD TO KNOW
- Closing the window does not stop monitoring. Kairos starts again when you log in.
- To stop it: click the Kairos menu bar icon -> Quit and stop monitoring.
- Documents are saved in the Kairos folder in your home folder (~/Kairos).
- Settings and logs: ~/Library/Application Support/Kairos

UNINSTALL
    bash ~/Library/Application\ Support/Kairos/uninstall.sh
