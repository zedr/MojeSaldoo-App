# VM Playbooks

## `create-vm.yml`

### Summary

Spins up a local CentOS Stream 10 VM on libvirt (`qemu:///system`). Downloads
the official GenericCloud qcow2 image (checksum-verified), creates a qcow2
overlay disk from it, and boots it with `virt-install --import`. No
cloud-init or other provisioning is done — the VM is left as a blank cloud
image for you to provision later (e.g. via the serial console or your own
tooling).

Requires `qemu-kvm`, `libvirt`, and `virt-install` — installed automatically
via `become` if missing. The invoking user must already be authorized against
`qemu:///system` (e.g. a member of the `libvirt` group), same as for
interactive `virsh` use.

### Run

```bash
ansible-playbook automation/vms/playbooks/create_centos_stream10_vm.yml \
  -e vm_name=my-centos-vm
```

Variables (override with `-e`):

| Variable | Default | Notes |
| --- | --- | --- |
| `vm_name` | `centos-stream10` | libvirt domain name |
| `vm_vcpus` | `2` | |
| `vm_memory_mb` | `4096` | |
| `vm_disk_gb` | `20` | size of the qcow2 overlay disk |
| `vm_network` | `default` | libvirt network to attach to |

### Connect

```bash
virsh --connect qemu:///system console my-centos-vm
```

The cloud image ships with no configured user/password and no SSH keys, so
console access via `virsh console` is the only way in until you provision it.

### Teardown

```bash
virsh --connect qemu:///system destroy my-centos-vm
virsh --connect qemu:///system undefine my-centos-vm --remove-all-storage
```
## `provision-vm.yml`

### Summary

Provisions the VM with the software and configuration needed to run the
MojeSaldoo application.

The application runs in rootless Podman containers inside the VM. These pods
have stateful volumes for the data, e.g. postgresql data. Pod orchestration
and management is done via systemd, **not** Podman Compose. This same
playbook is used for local libvirt dev VMs and for production/cloud VMs —
nothing in it is libvirt-specific (see `provision-vm.sh -H <host>`).

Upon first provisioning, a user `zedr` is created with a very strong randomly 
generated password which is printed via a `debug` task. User `zedr` is a 
member of wheel. The public SSH key specified in the playbook is added to the 
authorized users file. After this, SSH access for root is disabled.

Requires the `ansible.posix` and `community.crypto` collections
(`authorized_key`, `sysctl`, and the self-signed cert modules):

```bash
ansible-galaxy collection install -r automation/vms/requirements.yml
```

### Container topology

Containers are managed as rootless [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units — `.container`/`.network`/`.volume` files under
`~zedr/.config/containers/systemd/`, rendered from the Jinja2 templates in
`playbooks/templates/`. Podman's systemd generator turns these into
`systemd --user` services for `zedr` (kept running across reboots/logout by
the lingering enabled earlier in the playbook):

| Service | Image | Published ports | Notes |
| --- | --- | --- | --- |
| `mojesaldoo-db.service` | `postgres:16` | none | `Notify=healthy` gates startup ordering on an actual `pg_isready` pass, not just process start |
| `mojesaldoo-backend.service` | `mojesaldoo-backend:latest` | none | Django/gunicorn; reachable only on the internal `mojesaldoo` network |
| `mojesaldoo-proxy.service` | `mojesaldoo-proxy:latest` | `80`, `443` | Caddy; serves the production frontend build baked into the image and reverse-proxies `/api/*` to the backend; terminates TLS with a **self-signed certificate** (no ACME/Let's Encrypt) generated once by the playbook |

Publishing ports 80/443 as a rootless user requires lowering
`net.ipv4.ip_unprivileged_port_start`, which the playbook does via `sysctl`.

Secrets (the Postgres password and `DJANGO_SECRET_KEY`) are generated once on
first run and written to `0600` env files under `~zedr/.config/mojesaldoo/`;
re-running the playbook reads them back instead of rotating them.

### Image delivery (no registry)

There is no container registry involved. The playbook builds the `backend`
and `proxy` images **on the control host** (`delegate_to: localhost`),
`podman save`s them into a single tarball, copies that tarball to the VM, and
`podman load`s it into `zedr`'s rootless image store. This runs on every
provisioning pass, so re-running the playbook after a code change rebuilds
and redeploys the images (the Quadlet services are restarted, not just
started, for the same reason).

`postgres:16` has no Containerfile — it's a public base image, not something
built by this project — so it isn't built, only bundled: if `podman image
exists docker.io/library/postgres:16` on the control host, it's saved and
loaded alongside `backend`/`proxy` in the same tarball; otherwise it's left
out, and the db Quadlet unit pulls it straight from Docker Hub itself the
first time it starts. Bundling it when available avoids a slow first pull
over the VM's own network causing `mojesaldoo-db.service` to time out on
start (systemd's default `TimeoutStartSec` isn't long enough to pull a
~450 MB image, initialize Postgres, and pass the health check).

### Bootstrapping

The cloud image created by `create-vm.yml` has no user, password, or SSH key
configured, so Ansible can't reach it over SSH out of the box. Seeding root's
SSH access is a control-host operation (it edits the VM's qcow2 disk), so
`automation/vms/scripts/provision-vm.sh` does it — always use the script
rather than calling `ansible-playbook` directly:

```bash
automation/vms/scripts/provision-vm.sh my-centos-vm -u root
```

If your SSH private key is passphrase-protected, load it into `ssh-agent`
first — the script and Ansible authenticate non-interactively (`BatchMode`),
so an unloaded encrypted key makes every connection fail silently at
`Permission denied (publickey)`:

```bash
ssh-add ~/.ssh/id_ed25519
```

(The script preflight-checks for this and errors out with guidance if the key
isn't usable non-interactively.)

Idempotently, before running the playbook, the script:

1. Probes SSH key auth to the VM. If it already works, it skips straight to
   provisioning (this is what makes re-runs a no-op).
2. Otherwise it locates the VM's disk (`virsh domblklist`), installs
   `guestfs-tools` if needed, shuts the VM down, injects the SSH public key
   into `/root/.ssh/authorized_keys` on the disk via
   `virt-customize --ssh-inject`, and boots it back up.

The seeding step runs `dnf install guestfs-tools` and `virt-customize` against
the root-owned qcow2, so it uses `sudo` and may prompt for your **local** sudo
password. It only does this when seeding is actually needed, and only for
libvirt VMs resolved via `virsh` — with `-H <host>` (a host not managed by the
local libvirt) seeding is skipped, and that host must already have SSH access
configured by other means.

Since the last task disables root SSH login, the first run must connect as
`root` (the script's default). Subsequent re-runs should connect as `zedr`
(`-u zedr`, who has `sudo`/`become` via `wheel`) instead; either way, the
SSH-auth probe means the script never re-seeds an already-provisioned VM.

Variables (override with `-e`, or via the script's `-k`):

| Variable | Default | Notes |
| --- | --- | --- |
| `app_user` | `zedr` | user created on the VM |
| `zedr_ssh_pubkey_file` | `~/.ssh/id_ed25519.pub` | public key (on the control host) installed into `zedr`'s `authorized_keys`; the script also injects this key for root when seeding |
