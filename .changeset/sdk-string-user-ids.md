---
"@opslane/sdk": patch
---

`setUser` accepts numeric user and account IDs and sends them as strings. A numeric ID used to make session registration fail, which turned off session recording for signed-in users, and error events arrived without the user.
