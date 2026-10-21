# Stand-in for orlok_winrm.py in tests: prints what it was given and fails like the real helper.
import json
import os

with open(os.environ["ORLOK_WINRM_SCRIPT"], encoding="utf-8") as handle:
    script = handle.read()
print(f"{os.environ['ORLOK_WINRM_USER']}@{os.environ['ORLOK_WINRM_HOST']}:{os.environ['ORLOK_WINRM_PORT']} {os.environ['ORLOK_WINRM_SCHEME']}")
print(f"script: {script}")
print(f"password: {os.environ['ORLOK_WINRM_PASSWORD']}")
outcome = {"exitCode": 0, "error": None}
if os.environ["ORLOK_WINRM_PASSWORD"] == "wrong":
    outcome = {"exitCode": None, "error": "auth_failed"}
elif "exit 3" in script:
    outcome = {"exitCode": 3, "error": None}
with open(os.environ["ORLOK_WINRM_RESULT"], "w", encoding="utf-8") as handle:
    json.dump(outcome, handle)
