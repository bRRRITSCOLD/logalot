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
  backend.tf          # S3 backend: key, encrypt=true, use_lockfile=true
  versions.tf         # required_version >= 1.10, provider versions
  variables.tf        # input variables (region, project, env, etc.)
  providers.tf        # aws provider with default tags
  s3.tf               # cold-tier + Athena-results buckets (private/encrypted/versioned/lifecycle)
  glue.tf             # Glue catalog database + Athena workgroup (pay-per-scan cold queries)
  ssm.tf              # SSM SecureString parameter placeholders + least-privilege IAM instance profile
  dns.tf              # Route53 hosted zone + A record → EIP (ADR-0010)
  observability.tf    # CloudWatch OOM alarm + AWS Budget $30 @ 80/100% (ADR-0011)
  poc.tfvars.example  # copy to poc.tfvars (gitignored), fill in real values
  README.md           # this file
  bootstrap/          # one-time state-bucket creation (local state only)
  backend.tf       # S3 backend: key, encrypt=true, use_lockfile=true
  versions.tf      # required_version >= 1.10, provider versions
  variables.tf     # input variables (region, project, env, state_bucket, network, admin_cidr)
  providers.tf     # aws provider with default tags
  network.tf       # VPC, public subnet, IGW, route table (ADR-0009)
  security.tf      # EC2 security group: 443+80 open, 22 closed by default (SSM admin)
  outputs.tf       # exported IDs: vpc, subnet, igw, security group
  poc.tfvars.example  # copy to poc.tfvars (not committed) and fill in values
  README.md        # this file
  bootstrap/       # one-time state-bucket creation (local state only)
    main.tf
    variables.tf
    outputs.tf
```

## Secrets (SSM Parameter Store)

Secret parameters are created as `SecureString` placeholders by Terraform.
Write real values out-of-band **before** `docker compose up` on the instance:

```bash
aws ssm put-parameter \
  --name "/logalot/poc/oauth/google/client_secret" \
  --type SecureString \
  --value "<real_secret>" \
  --overwrite
```

The EC2 instance role (`logalot-poc-ec2-instance`) is scoped to
`ssm:GetParameter*` on `/logalot/<env>/*` only — no wildcard resource or
action (ADR-0010, R8).
## Security group policy

The SG (`security.tf`) opens only **443** and **80** inbound to the world.  Port
**22 is closed by default** — use **SSM Session Manager** for admin access (no
IAM key, no open port).  If you need SSH as a fallback, set `admin_cidr` in your
`poc.tfvars` to your IP (`x.x.x.x/32`).

A static policy assertion script runs in CI (no AWS credentials required):

```bash
bash scripts/tf-sg-policy-assert.sh infra/aws/security.tf
```

Asserts:
- Port 22 has no static `0.0.0.0/0` ingress rule.
- Port 443 and 80 are open to `0.0.0.0/0`.

## CI

The `tf-validate` GitHub Actions job (`.github/workflows/tf-validate.yml`) runs
`terraform init -backend=false`, `terraform validate`, `terraform fmt -check`,
and the SG policy assertion script on every PR touching `infra/aws/**`.
