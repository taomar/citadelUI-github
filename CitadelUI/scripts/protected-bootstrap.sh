#!/usr/bin/env bash
# Run as root by protected-transfer.ps1 AFTER approval. Ubuntu 22.04 amd64 only.
# No inbound login, imported credentials, Docker-in-Docker or mounted host socket.
# Egress: HTTPS to archive.ubuntu.com, security.ubuntu.com, packages.microsoft.com,
# download.docker.com, github.com/release-assets.githubusercontent.com, MCR,
# Docker Hub/auth/CDNs and Azure control-plane endpoints. NSG limits ports, NOT
# FQDNs. NAT is explicit egress, not an Azure Firewall and not air-gapped.
set -Eeuo pipefail
umask 077
trap 'printf "Protected toolchain bootstrap failed at line %s; no deployment was started.\n" "$LINENO" >&2' ERR
[[ "$(id -u)" == 0 ]]
[[ "$(dpkg --print-architecture)" == amd64 ]]
# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 22.04 ]]

quiet() {
  local text code
  if text=$("$@" 2>&1); then return 0; else
    code=$?
    printf 'Toolchain operation %s failed (exit %s).\n' "$1" "$code" >&2
    # Bootstrap handles public package/tool downloads only, never cloud credentials.
    printf '%s\n' "$text" | tail -n 20 >&2
    return "$code"
  fi
}
verify_tools() {
  [[ "$(azd version)" == "azd version 1.33.0 "* ]]
  [[ "$(pwsh -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()')" == 7.4.13 ]]
  [[ "$(bicep --version)" == "Bicep CLI version 0.46.1 "* ]]
  quiet az version
  quiet docker version
  quiet docker buildx version
}
install -d -m 700 /var/lib/citadel-protected
# Azure Custom Script does not guarantee HOME, even when running as root.
export HOME=/var/lib/citadel-protected/home
install -d -m 700 "$HOME"
marker=/var/lib/citadel-protected/toolchain-v1
if [[ -f "$marker" ]]; then
  verify_tools
  printf 'Protected toolchain already installed and verified.\n'
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
export AZURE_CORE_COLLECT_TELEMETRY=no
export AZD_COLLECT_TELEMETRY=no
# The stock Ubuntu image contains Python/CA certificates for its Azure agent.
# Convert the Ubuntu feed to HTTPS before apt; NSG deliberately denies Internet
# port 80. Do not download and execute curl|bash installation scripts.
python3 -c 'from pathlib import Path
p=Path("/etc/apt/sources.list")
s=p.read_text().replace("http://azure.archive.ubuntu.com/ubuntu", "https://archive.ubuntu.com/ubuntu").replace("http://archive.ubuntu.com", "https://archive.ubuntu.com").replace("http://security.ubuntu.com", "https://security.ubuntu.com")
p.write_text(s)'
quiet apt-get update
quiet apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 git
work=$(mktemp -d /var/lib/citadel-protected/tools.XXXXXXXX)
download() {
  quiet curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 30 --max-time 900 --output "$2" "$1"
}
check_sha() {
  python3 -c 'import hashlib,sys
from pathlib import Path
if hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit("Official tool asset checksum mismatch; refusing installation.")' "$1" "$2"
}

# Signed official Microsoft Azure CLI and Docker Engine apt repositories.
download https://packages.microsoft.com/keys/microsoft.asc "$work/microsoft.asc"
download https://download.docker.com/linux/ubuntu/gpg "$work/docker.asc"
quiet gpg --batch --yes --dearmor --output /usr/share/keyrings/citadel-microsoft.gpg "$work/microsoft.asc"
quiet gpg --batch --yes --dearmor --output /usr/share/keyrings/citadel-docker.gpg "$work/docker.asc"
chmod 644 /usr/share/keyrings/citadel-microsoft.gpg /usr/share/keyrings/citadel-docker.gpg
python3 -c 'from pathlib import Path
feeds={
"citadel-azure-cli.list": "deb [arch=amd64 signed-by=/usr/share/keyrings/citadel-microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ jammy main\n",
"citadel-docker.list": "deb [arch=amd64 signed-by=/usr/share/keyrings/citadel-docker.gpg] https://download.docker.com/linux/ubuntu jammy stable\n"}
for name,text in feeds.items():
    p=Path("/etc/apt/sources.list.d")/name
    p.write_text(text)
    p.chmod(0o644)'
quiet apt-get update
quiet apt-get install -y --no-install-recommends azure-cli docker-ce docker-ce-cli containerd.io docker-buildx-plugin

# SHA-256 values from the publishers' release-asset digests. Version changes
# require reviewing/updating these hashes, not silently following "latest".
download https://github.com/Azure/azure-dev/releases/download/azure-dev-cli_1.33.0/azd_1.33.0_amd64.deb "$work/azd.deb"
check_sha "$work/azd.deb" f5e12cb07d05aa86629eb09c640edfa600aabb9512385ec8a049d54227f4a96e
download https://github.com/PowerShell/PowerShell/releases/download/v7.4.13/powershell_7.4.13-1.deb_amd64.deb "$work/powershell.deb"
check_sha "$work/powershell.deb" 8f49e9213060dc8860e41dc2da9c48c3ba7b376d2857b3096b76d0f8004eb378
download https://github.com/Azure/bicep/releases/download/v0.46.1/bicep-linux-x64 "$work/bicep"
check_sha "$work/bicep" 3e011d629ea4311b7a7dd8f0040ab2b1a072ea4ff5d02cb75e0e55a9a6703fb9
quiet apt-get install -y --no-install-recommends "$work/azd.deb" "$work/powershell.deb"
install -m 755 "$work/bicep" /usr/local/bin/bicep
quiet systemctl enable --now docker
# No user is added to the docker group. Only this root-controlled build process
# uses Docker; the application still runs as 10001 with no Docker socket.
verify_tools
python3 -c 'from pathlib import Path
Path("/var/lib/citadel-protected/toolchain-v1").write_text("azd=1.33.0;pwsh=7.4.13;bicep=0.46.1;ubuntu=22.04;amd64\n")'
printf 'Protected toolchain installed and verified (azd 1.33.0, PowerShell 7.4.13, Bicep 0.46.1).\n'
