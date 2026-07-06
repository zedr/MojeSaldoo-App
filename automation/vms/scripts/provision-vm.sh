#!/usr/bin/env bash
# Wrapper for playbooks/provision-vm.yml: provisions a VM for rootless
# Podman. See playbooks/README.md for bootstrap requirements — the first
# run must connect as root (-u root); subsequent runs should use -u zedr.
#
# By default resolves the target VM's IP via `virsh domifaddr` against a
# local libvirt domain name (as created by create-vm.sh); pass -H to target
# a host/IP directly instead (e.g. for a VM not on the local libvirt).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYBOOK="${SCRIPT_DIR}/../playbooks/provision-vm.yml"

# These are throwaway dev VMs (recreated by create-vm.sh, new host key each
# time), so skip Ansible's interactive host-key verification — otherwise the
# provisioning play hangs on a fingerprint prompt for the unknown host. The
# inventory also passes StrictHostKeyChecking=no to the underlying ssh.
export ANSIBLE_HOST_KEY_CHECKING=False

usage() {
  cat <<'EOF'
Usage: provision-vm.sh [vm_name] [-H host] [-u ssh_user] [-k ssh_pubkey_file] [-- ansible-playbook-args...]

  [vm_name]           libvirt domain name to resolve via `virsh domifaddr`
                       (default: centos-stream10, matching create-vm.yml's
                       default vm_name). Ignored if -H is given.
  -H host             IP address or hostname of the VM, bypassing the
                       virsh domifaddr lookup
  -u ssh_user         SSH user to connect as (default: root, for the first
                       bootstrap run; use zedr for subsequent runs)
  -k ssh_pubkey_file  Public key file (on this machine) to install into
                       zedr's authorized_keys (default: ~/.ssh/id_ed25519.pub)

Examples:
  # First run: bootstrap as root, resolving the default VM's IP via virsh
  provision-vm.sh -u root

  # Target a specific libvirt VM by name
  provision-vm.sh my-centos-vm -u root

  # Target a host directly, skipping the virsh lookup
  provision-vm.sh -H 192.168.122.50 -u zedr
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

vm_name="centos-stream10"
host=""
ssh_user="root"
pubkey_file=""
extra_args=()

if [[ $# -gt 0 && "$1" != -* ]]; then
  vm_name="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -H) host="$2"; shift 2 ;;
    -u) ssh_user="$2"; shift 2 ;;
    -k) pubkey_file="$2"; shift 2 ;;
    --)
      shift
      extra_args+=("$@")
      break
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Preflight: both the seeding probe and Ansible authenticate to the VM with
# key auth non-interactively (BatchMode). If the private key is passphrase-
# protected and not loaded into ssh-agent, ssh can offer the key but can't
# sign, so every connection fails at "Permission denied (publickey)" with no
# obvious cause. Catch that here with actionable guidance.
priv_key="${pubkey_file:-${HOME}/.ssh/id_ed25519.pub}"
priv_key="${priv_key%.pub}"
if ! ssh-add -l >/dev/null 2>&1; then
  # No identities in the agent — usable only if the private key is unencrypted.
  if [[ ! -f "${priv_key}" ]] || ! ssh-keygen -y -P "" -f "${priv_key}" >/dev/null 2>&1; then
    echo "error: cannot authenticate to the VM non-interactively." >&2
    echo "Your SSH key ('${priv_key}') appears to be passphrase-protected and is" >&2
    echo "not loaded into ssh-agent, so key-based (BatchMode) auth will silently" >&2
    echo "fail. Load it first, then re-run this script:" >&2
    echo "    ssh-add ${priv_key}" >&2
    exit 1
  fi
fi

resolved_via_virsh=false
if [[ -z "${host}" ]]; then
  echo "Looking up the IP address of '${vm_name}' via virsh domifaddr..." >&2
  host="$(virsh --connect qemu:///system domifaddr "${vm_name}" | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1)"
  if [[ -z "${host}" ]]; then
    echo "Could not determine an IPv4 address for '${vm_name}'. Pass -H <host> to specify it directly." >&2
    exit 1
  fi
  echo "Resolved '${vm_name}' to ${host}" >&2
  resolved_via_virsh=true
fi

# provision-vm.yml targets the `mojesaldoo_vms` group, so build a throwaway
# ini inventory for the single target host rather than requiring a
# hand-maintained inventory file.
inventory_file="$(mktemp)"
trap 'rm -f "${inventory_file}"' EXIT

{
  echo "[mojesaldoo_vms]"
  echo "${host} ansible_user=${ssh_user} ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'"
} > "${inventory_file}"

extra_vars=()
if [[ -n "${pubkey_file}" ]]; then
  extra_vars+=(-e "zedr_ssh_pubkey_file=${pubkey_file}")
fi

ssh_probe() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 \
    "${ssh_user}@${host}" true 2>/dev/null
}

# Seed root's SSH key on a fresh cloud VM so Ansible can reach it. This is a
# control-host operation (it edits the VM's qcow2 with virt-customize, which
# needs the VM shut off and local root), so it runs here with plain sudo
# rather than inside the playbook. Idempotent: only runs when key auth to the
# VM isn't already working, and only for libvirt VMs we resolved via virsh.
seed_root_ssh() {
  local seed_pubkey="${pubkey_file:-${HOME}/.ssh/id_ed25519.pub}"
  if [[ ! -f "${seed_pubkey}" ]]; then
    echo "SSH public key '${seed_pubkey}' not found (override with -k)." >&2
    exit 1
  fi

  local disk
  disk="$(virsh --connect qemu:///system domblklist --details "${vm_name}" \
    | awk '$2 == "disk" { print $4; exit }')"
  if [[ -z "${disk}" ]]; then
    echo "Could not determine the disk path for '${vm_name}'." >&2
    exit 1
  fi

  echo "Seeding root SSH access on '${vm_name}' (${disk})." >&2
  echo "This needs local root (dnf + virt-customize) — you may be prompted for sudo." >&2

  if ! command -v virt-customize >/dev/null 2>&1; then
    echo "Installing guestfs-tools (provides virt-customize)..." >&2
    sudo dnf install -y guestfs-tools
  fi

  # virt-customize needs the VM shut off to safely edit its disk.
  local state
  state="$(virsh --connect qemu:///system domstate "${vm_name}" 2>/dev/null || echo unknown)"
  if [[ "${state}" != "shut off" ]]; then
    echo "Shutting down '${vm_name}'..." >&2
    virsh --connect qemu:///system shutdown "${vm_name}" || true
    local i
    for i in $(seq 1 24); do
      state="$(virsh --connect qemu:///system domstate "${vm_name}" 2>/dev/null || echo unknown)"
      [[ "${state}" == "shut off" ]] && break
      sleep 5
    done
    if [[ "${state}" != "shut off" ]]; then
      echo "Graceful shutdown timed out; forcing power off..." >&2
      virsh --connect qemu:///system destroy "${vm_name}" || true
    fi
  fi

  echo "Injecting root SSH key into the disk..." >&2
  sudo virt-customize -a "${disk}" --ssh-inject "root:file:${seed_pubkey}"

  echo "Starting '${vm_name}'..." >&2
  virsh --connect qemu:///system start "${vm_name}"

  echo "Waiting for SSH key auth to come up..." >&2
  local i
  for i in $(seq 1 24); do
    if ssh_probe; then
      echo "SSH key auth is up." >&2
      return 0
    fi
    sleep 5
  done
  echo "Timed out waiting for SSH key auth after seeding '${vm_name}'." >&2
  exit 1
}

# Seeding only applies to libvirt VMs (resolved via virsh); with -H the target
# must already have SSH access configured by other means.
if [[ "${resolved_via_virsh}" == true ]] && ! ssh_probe; then
  seed_root_ssh
fi

exec ansible-playbook "${PLAYBOOK}" -i "${inventory_file}" \
  "${extra_vars[@]}" "${extra_args[@]}"
