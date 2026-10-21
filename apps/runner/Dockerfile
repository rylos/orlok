# Orlok runner image. Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t orlok-runner .

FROM node:22-alpine AS build
RUN npm install -g pnpm@11.26.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/runner/package.json apps/runner/
RUN pnpm install --frozen-lockfile --filter @orlok/runner...
COPY packages/shared packages/shared
COPY apps/runner apps/runner
RUN pnpm --filter @orlok/runner build

FROM node:22-alpine
# uv provides uvx for MCP servers written in Python; util-linux-misc provides prlimit.
# Network and systems tools for an IT office: certificates (openssl), whois, rsync, packet capture
# (tcpdump), SNMP, IPMI, Redis/Valkey, LDAP and SMB clients.
RUN apk add --no-cache \
      bind-tools ca-certificates curl git ipmitool iputils jq mariadb-client mtr net-snmp-tools \
      netcat-openbsd nmap openldap-clients openssh-client-default openssl postgresql-client \
      python3 rsync samba-client setpriv sshpass tcpdump tini tzdata util-linux-misc uv \
      valkey-cli wget whois \
  && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup -g 10001 runner \
  && adduser -D -u 10001 -G runner -h /home/runner runner \
  && apk add --no-cache --virtual .setcap libcap-setcap \
  # Only the runner user may execute this copy of setpriv, which can switch to sandbox uids.
  && mkdir -p /usr/local/libexec \
  && cp "$(command -v setpriv)" /usr/local/libexec/orlok-setpriv \
  && chown root:runner /usr/local/libexec/orlok-setpriv \
  && chmod 0750 /usr/local/libexec/orlok-setpriv \
  && setcap cap_setuid,cap_setgid+ep /usr/local/libexec/orlok-setpriv \
  && apk del .setcap

# sqlcmd (go-sqlcmd): a static binary with no ODBC driver, so colleagues can query SQL Server
# from the runner instead of going through a Windows server. Verified against its checksum;
# only the release binary is kept, not the debug one.
ARG SQLCMD_VERSION=1.10.0
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=amd64; sha=92516d98c63d99b0994de5b61350c91f6915f9b76f139a59039fbcb225c2e987 ;; \
      aarch64) arch=arm64; sha=9faaa981f9c374f319ac796dedb4678499b8596c87d5b6c512e9b0e7a3b74f8e ;; \
      *) echo "sqlcmd: unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache --virtual .sqlcmd bzip2; \
    curl -fsSL -o /tmp/sqlcmd.tar.bz2 \
      "https://github.com/microsoft/go-sqlcmd/releases/download/v${SQLCMD_VERSION}/sqlcmd-linux-${arch}.tar.bz2"; \
    echo "${sha}  /tmp/sqlcmd.tar.bz2" | sha256sum -c -; \
    tar xjf /tmp/sqlcmd.tar.bz2 -C /tmp sqlcmd; \
    install -m 0755 /tmp/sqlcmd /usr/local/bin/sqlcmd; \
    rm -f /tmp/sqlcmd /tmp/sqlcmd.tar.bz2; \
    apk del .sqlcmd

# PowerShell (pwsh) for scripts run on the runner itself. Microsoft builds it for musl only on
# x86_64; on other architectures the image goes without. Verified against its checksum.
ARG PWSH_VERSION=7.6.6
ARG PWSH_SHA256=9537c256a60c34f6bc2dd60c1c10b31a0c2ef26e96799d066be78325ab4947cc
RUN set -eu; \
    if [ "$(uname -m)" = "x86_64" ]; then \
      apk add --no-cache icu-libs krb5-libs libgcc libintl libssl3 libstdc++ lttng-ust \
        userspace-rcu zlib; \
      curl -fsSL -o /tmp/pwsh.tar.gz \
        "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-musl-x64.tar.gz"; \
      echo "${PWSH_SHA256}  /tmp/pwsh.tar.gz" | sha256sum -c -; \
      mkdir -p /opt/microsoft/powershell; \
      tar xzf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell; \
      chmod +x /opt/microsoft/powershell/pwsh; \
      ln -s /opt/microsoft/powershell/pwsh /usr/local/bin/pwsh; \
      rm -f /tmp/pwsh.tar.gz; \
    else \
      echo "pwsh: no musl build for $(uname -m), skipped"; \
    fi
ENV POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# WinRM to Windows hosts without OpenSSH (R-OPS-2): pypsrp in its own environment, used only by
# the runner's helper, which receives the password through its environment.
ARG PYPSRP_VERSION=0.9.1
RUN uv venv --python /usr/bin/python3 /opt/orlok-winrm \
  && uv pip install --no-cache --python /opt/orlok-winrm/bin/python "pypsrp==${PYPSRP_VERSION}"
COPY apps/runner/winrm/orlok_winrm.py /usr/local/libexec/orlok_winrm.py

WORKDIR /app
COPY --from=build /repo/apps/runner/dist/index.mjs /app/index.mjs
# The license travels with every copy (BSL 1.1).
COPY LICENSE /app/LICENSE
LABEL org.opencontainers.image.licenses="BUSL-1.1"

ENV NODE_ENV=production \
    PORT=3100 \
    ORLOK_RUNNER_SANDBOX_UID_BASE=20000
USER runner
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/v1/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/index.mjs"]
