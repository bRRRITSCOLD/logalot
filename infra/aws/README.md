# infra/aws — Terraform root module

Provisions the logalot AWS infrastructure for the PoC environment as described
in [ADR-0009](../../docs/adr/0009-aws-deployment-topology.md) and
[ADR-0010](../../docs/adr/0010-iac-secrets-tls.md).

## State backend

Terraform state is stored in an **S3 bucket** with:

- **Versioning** — every state write creates a new version; accidental deletes
  are recoverable.
- **SSE-S3 encryption** (`AES256`) at rest — free, no CMK needed for the PoC.
- **TLS-only + deny-unencrypted-upload** bucket policy.
- **Native S3 state locking** (Terraform ≥ 1.10 conditional writes) — no
  DynamoDB lock table required (ADR-0010).

## Quick start

### 1 — Bootstrap the state bucket (once per environment)

```bash
cd infra/aws/bootstrap
terraform init
terraform apply -var="env=poc"
# note the output: state_bucket_name
```

### 2 — Initialise the main module

```bash
cd infra/aws
terraform init \
  -backend-config="bucket=<state_bucket_name>" \
  -backend-config="region=us-east-1"
```

Or create a local `backend.hcl` (not committed — add to `.gitignore`):

```hcl
bucket = "logalot-poc-tf-state-<account_id>"
region = "us-east-1"
```

```bash
terraform init -backend-config=backend.hcl
```

### 3 — Plan / Apply

```bash
terraform validate
terraform fmt -check
terraform plan  -var-file=poc.tfvars
terraform apply -var-file=poc.tfvars
```

## Directory layout

```
infra/aws/
  backend.tf       # S3 backend: key, encrypt=true, use_lockfile=true
  versions.tf      # required_version >= 1.10, provider versions
  variables.tf     # input variables (region, project, env, state_bucket)
  providers.tf     # aws provider with default tags
  README.md        # this file
  bootstrap/       # one-time state-bucket creation (local state only)
    main.tf
    variables.tf
    outputs.tf
```

## CI

The `tf-validate` GitHub Actions job (`.github/workflows/tf-validate.yml`) runs
`terraform init -backend=false`, `terraform validate`, and `terraform fmt -check`
on every PR touching `infra/aws/**`.
