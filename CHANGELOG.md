# Changelog

## 1.1.0

- Split the Bridge into database, RAG, gateway and safety modules.
- Added comment drafting, lead alerts, daily reports and compliance preflight.
- Prevented cross-tab duplicate autonomous sends with a background lease.
- Restored virtual-list coverage for conversations and messages.
- Prevented stale workspace credentials from silently creating an empty replacement workspace.
- Restricted message timestamps to dedicated time nodes and isolated drafts between customers.
- Removed personal business defaults and clarified BYOK data flow.
- Added endpoint regression tests, reproducible release archives and GitHub CI/release workflows.
- Correctly detected Xiaohongshu's 180° inverted message scroller instead of jumping to old messages.
- Excluded the top account name from customer-identity cross-checks and counted uncertain sends against the hourly cap.
- Added live Bridge health and secure-mode status to the settings page.

## 1.0.3

- Added real comment retrieval through the local XHS CLI and public-reply drafting.

## 1.0.2

- Made local self-hosting the default and removed bundled remote service endpoints.
- Hardened CORS, BYOK behavior, tenant isolation and reply safety guards.
