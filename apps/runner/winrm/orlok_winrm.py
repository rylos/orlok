"""Runs one PowerShell script on a Windows host over WinRM (PSRP) for the Orlok runner.

Everything comes from the environment, never from the command line, which other processes can
read: ORLOK_WINRM_HOST, ORLOK_WINRM_PORT, ORLOK_WINRM_USER, ORLOK_WINRM_PASSWORD,
ORLOK_WINRM_SCHEME (http or https), ORLOK_WINRM_SCRIPT (path of the script) and
ORLOK_WINRM_RESULT (path where the outcome is written as JSON: exitCode and error).

Over http the session is encrypted by NTLM or Kerberos message encryption; over https the
server certificate is verified against the system CAs. Output lines are printed as they arrive.
"""

import json
import os
import sys
import time

RESULT = os.environ.get("ORLOK_WINRM_RESULT", "")

# The command runs in a script block: its errors are written with the output, in order, and
# remembered so that a command that wrote an error and set no exit code still fails.
WRAPPER = """$ProgressPreference = 'SilentlyContinue'
$global:LASTEXITCODE = 0
$global:OrlokFailed = $false
& {
%s
} 2>&1 | ForEach-Object {
  if ($_ -is [System.Management.Automation.ErrorRecord]) {
    $global:OrlokFailed = $true
    "ERROR: $($_.ToString())"
  } else { $_ }
} | Out-String -Stream -Width 250
"""

EXIT_CODE = "if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($global:OrlokFailed) { 1 } else { 0 }"


def finish(exit_code, error=None):
    if RESULT:
        with open(RESULT, "w", encoding="utf-8") as handle:
            json.dump({"exitCode": exit_code, "error": error}, handle)
    sys.stdout.flush()
    sys.exit(0)


def classify(error):
    text = f"{type(error).__name__}: {error}"
    lowered = text.lower()
    if "401" in text or "authenticat" in lowered or "logon failure" in lowered or "credentials" in lowered:
        return "auth_failed"
    if any(
        word in lowered
        for word in ("connection refused", "timed out", "timeout", "name or service not known",
                     "no route to host", "network is unreachable", "max retries", "failed to establish")
    ):
        return "unreachable"
    if "certificate" in lowered or "ssl" in lowered:
        return "certificate_invalid"
    return None


def main():
    try:
        from pypsrp.powershell import PowerShell, RunspacePool
        from pypsrp.wsman import WSMan
    except ImportError as error:  # pragma: no cover - image problem
        print(f"pypsrp is not available: {error}", file=sys.stderr)
        finish(None, "spawn_failed")

    with open(os.environ["ORLOK_WINRM_SCRIPT"], encoding="utf-8") as handle:
        command = handle.read()
    https = os.environ.get("ORLOK_WINRM_SCHEME", "http") == "https"
    wsman = WSMan(
        os.environ["ORLOK_WINRM_HOST"],
        port=int(os.environ["ORLOK_WINRM_PORT"]),
        username=os.environ["ORLOK_WINRM_USER"],
        password=os.environ["ORLOK_WINRM_PASSWORD"],
        ssl=https,
        cert_validation=True,
        auth="negotiate",
        encryption="always" if not https else "auto",
        connection_timeout=10,
        operation_timeout=20,
    )
    try:
        with RunspacePool(wsman) as pool:
            ps = PowerShell(pool)
            ps.add_script(WRAPPER % command)
            ps.begin_invoke()
            printed = 0
            while True:
                ps.poll_invoke(timeout=5)
                while printed < len(ps.output):
                    print(str(ps.output[printed]), flush=True)
                    printed += 1
                if ps.state not in (2, 0):  # 0 not started, 2 running
                    break
            ps.end_invoke()
            while printed < len(ps.output):
                print(str(ps.output[printed]), flush=True)
                printed += 1
            for record in ps.streams.error:
                print(str(record), file=sys.stderr, flush=True)
            if ps.had_errors and not ps.output:
                finish(1)
            status = PowerShell(pool)
            status.add_script(EXIT_CODE)
            values = status.invoke()
            code = int(str(values[0])) if values else (1 if ps.had_errors else 0)
            finish(code)
    except Exception as error:  # noqa: BLE001 - reported to the job, never raised
        kind = classify(error)
        print(f"WinRM: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        finish(None, kind or "winrm_error")


if __name__ == "__main__":
    main()
