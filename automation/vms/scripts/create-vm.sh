#!/usr/bin/env bash
# Wrapper for playbooks/create-vm.yml: spins up a local CentOS Stream 10
# libvirt VM. See playbooks/README.md for details.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYBOOK="${SCRIPT_DIR}/../playbooks/create-vm.yml"

usage() {
  cat <<'EOF'
Usage: create-vm.sh <vm_name> [-c vcpus] [-m memory_mb] [-d disk_gb] [-n network]

  <vm_name>   libvirt domain name (required)
  -c vcpus    number of vCPUs (default: 2)
  -m mb       memory in MB (default: 4096)
  -d gb       overlay disk size in GB (default: 20)
  -n network  libvirt network to attach to (default: default)

Example:
  create-vm.sh my-centos-vm
EOF
}

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 1
fi

vm_name="$1"
shift

extra_vars=(-e "vm_name=${vm_name}")

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) extra_vars+=(-e "vm_vcpus=$2"); shift 2 ;;
    -m) extra_vars+=(-e "vm_memory_mb=$2"); shift 2 ;;
    -d) extra_vars+=(-e "vm_disk_gb=$2"); shift 2 ;;
    -n) extra_vars+=(-e "vm_network=$2"); shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

exec ansible-playbook "${PLAYBOOK}" "${extra_vars[@]}"
