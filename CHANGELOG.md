# Changelog

## Unreleased

- Add onboarding gate (name + theme) and joining-peers UI/notifications.
- Add peer status flow: `Joined`, `Downloading` (progress), `Downloaded`, remove on leave.
- Add WebRTC host peer status reporting for web join/download events.
- Add background-mode quit behavior (`Cmd+Q` hides app, Tray stays active; tray quit prompts before full shutdown).
- Fix dev worker startup/storage behavior for faster readiness with `--storage`.
