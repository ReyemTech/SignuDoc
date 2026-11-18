# SignuDoc on ReyemTech IAD-1

This draft targets a US data plane and uses the [generic SignuDoc Helm chart](kubernetes.md). It requires credentialed staging, interruption tests, and a restore before production use. Keep resolved deployment settings in private GitOps and provision credential values in Vault.

## Published packages

The [fork publishing workflow](../.github/workflows/publish-packages.yml) runs on pushes to main, pushes of version tags, and manual dispatches in **ReyemTech/SignuDoc**. It publishes these artifacts.

| Artifact | Reference |
| --- | --- |
| App image | ghcr.io/reyemtech/signudoc:&lt;full-commit-sha&gt; |
| Migration image | ghcr.io/reyemtech/signudoc-migrate:&lt;full-commit-sha&gt; |
| OCI chart | oci://ghcr.io/reyemtech/charts/signudoc |

The Linux amd64 images share the same commit tag, which the app build also uses for Next.js version skew protection. The image builds attach BuildKit provenance and SBOMs. The chart defaults point to both commit tags. Main and manual branch builds use the chart version with a `-sha-<full-commit-sha>` suffix. To publish a stable version, push a `v<version>` tag that matches both `package.json` and the chart's `appVersion`. Bump `Chart.yaml`'s independent `version` for each stable chart release. The workflow reuses existing SHA-tagged images, rejects a chart version with different image defaults, and reports the verified image and chart digests in the run summary.

GHCR packages start private. Ensure the fork has Actions access to all three packages, including any pre-existing package in the organization. Use a GHCR credential with package read access to provision a pull Secret named `signudoc-registry` for both images in the SignuDoc namespace. Give the Argo CD repo server separate read access to the private OCI chart and the private GitOps repo. For the chart, register `ghcr.io/reyemtech/charts` as a Helm repository with OCI enabled. Store all credentials through your secret manager. [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [Argo CD repository credentials](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#repositories).

## Prepare the deployment

1. Provision the `signudoc` namespace. Confirm that Traefik uses the `traefik` ingress class, cert-manager has the `letsencrypt-http` ClusterIssuer, and External Secrets Operator has access to the Vault `vault-backend` ClusterSecretStore. Check that the existing Argo CD project allows both sources, the namespace, and the resources in the application. Provision the registry credentials before the first sync.
2. Provision a private **durable external S3 bucket** for documents. Enable object versioning and choose a recovery window. Put CNPG backups in a separate bucket with a dedicated prefix and separate credentials. Scope the application principal to the document bucket and the Barman principal to the backup bucket and prefix. Allow only the operations required by each workload and test backup retention and restore with that policy. Use storage that survives cluster and node losses. A single-pod object store in the cluster shares those failure modes.
3. Copy the [infrastructure examples](../deploy/reyemtech/infrastructure) to a separate infrastructure application or directory in private GitOps. Fill the Vault paths and backup destination, pin a tested PostgreSQL 17 image, and rename the `.yaml.example` files to `.yaml` only when ready to apply. Create the Vault entries before applying the two ExternalSecrets. Generate and back up a stable `BETTER_AUTH_SECRET` of at least 32 characters, a randomly generated `CRON_SECRET`, and a private `SETUP_TOKEN`. Add the Resend and document S3 credentials to the app entry. Back up the PDF seal credentials as well if using a custom seal.
4. Wait for both ExternalSecrets to report **Ready** and for CNPG to report a healthy three-instance cluster. Confirm that WAL archiving works and run a credentialed test backup and restore. CNPG generates `signudoc-db-app` with the `uri` field and `signudoc-db-ca` with `ca.crt`. The app and migration Job mount the CA read-only and use `NODE_EXTRA_CA_CERTS` and `PGSSLMODE=verify-full` with the CNPG service hostname in the URI. Before syncing the app, confirm that both Secrets exist and that the app can reach the CNPG read-write Service. Keep the example ScheduledBackup suspended until the destination and restore work, then set `suspend: false` for daily backups. The example uses the legacy `barmanObjectStore` integration in CNPG 1.30. Move to the Barman Cloud Plugin before upgrading to a version that removes the built-in integration.
5. Copy the [workload directory](../deploy/reyemtech/workload) to the same path in private GitOps. Set the app URL, S3 bucket and signing region, Resend sender, and Ingress host and TLS hosts. For S3-compatible storage, set the HTTPS endpoint and use the addressing mode your provider requires. For AWS S3, remove the example endpoint and set `S3_FORCE_PATH_STYLE` to `"false"`. If using a workload credential provider, adapt the pod identity and remove the AWS access key entries from the ExternalSecret. Verify that the chosen provider refreshes credentials during a pod's lifetime. Configure a Traefik request body limit of at least 25 MB if a middleware caps uploads.
6. Commit the workload files before filling the [Argo CD Application example](../deploy/reyemtech/argocd-application.yaml.example). Set its existing project, private GitOps repo and exact workload commit, then set the exact chart version from the publishing run. Keep the Helm release name `signudoc` so the Deployment, required node placement, and PDB use the same selector. Rename the Application example to `.yaml` in private GitOps when ready. Leave automated sync disabled. Preview and run a **full manual sync** after infrastructure is ready. Confirm that the PreSync migration succeeds and the two app replicas become ready.
7. Enable ingress separately after setting the final domain and TLS configuration. Update the Application to point at that workload commit and sync it manually. Restrict access while completing `/setup` with your setup token, then check login, upload and signing from the external URL. Review the existing scheduler before enabling scheduled retention on a migrated install. Only one scheduler should invoke the retention endpoint for the same data.

The app deployment example uses environment variables for Secret data. ESO reconciles Secret contents, and existing pods keep their environment until restarted. Roll out the app after changing environment or Secret inputs, including ambient AWS endpoint or credential-source settings. Verify the next migration starts with the new connection settings. Expiring credentials supplied by an SDK provider continue to refresh normally. Keep the auth secret stable across replicas and restores. A secret change can affect active sessions and encrypted seal data.

## Placement and interruption tests

The app uses two S3-backed replicas without a document PVC. Required pod anti-affinity uses `kubernetes.io/hostname`. This needs two eligible amd64 nodes for steady state and a **third eligible node** for a rolling update's surge pod. Check admission for the actual manifests and confirm resources, taints, NetworkPolicies, DNS, and registry access on all eligible nodes. The PDB with `minAvailable: 1` limits voluntary disruption through the eviction API. Spot interruption and node loss are involuntary. Keep spare capacity for rescheduling and assume that losing several spot nodes at once can interrupt service.

CNPG requires three eligible nodes with distinct hostnames. Each PostgreSQL instance uses an `ssd` ReadWriteOnce claim. Before relying on failover, check volume attachment limits and volume topology, and confirm that a replacement node can attach each existing volume after detachment. Hostname separation reduces same-node losses. Confirm failure-domain placement directly with the provider since this cluster has no zone labels. Synchronous replication requires a standby for writes, and failover quorum can delay promotion when several database instances disappear. The database and backups share dependencies on the storage provider and region. Staging must exercise losing a primary or app node, recovery of both workloads, and database point-in-time restore with a compatible document version. Check an interrupted upload and signing request against app, database, object-storage and email records before retrying an operation with an unknown outcome.

Keep customer document data, PostgreSQL, backups, logs, keys and all providers that handle customer data in the US, including email processing. Verify provider settings and handling before taking customer data. A Canadian residency deployment requires a separate Canadian data plane for all of these dependencies, including backups, logs, keys and providers.

## Render a published chart locally

Use a read-only registry credential if the package is private. This renders the inactive example without making changes to a cluster.

```bash
version=replace-with-published-chart-version
helm pull oci://ghcr.io/reyemtech/charts/signudoc --version "$version"
helm lint "signudoc-$version.tgz" -f deploy/reyemtech/workload/values.yaml
helm template signudoc "signudoc-$version.tgz" --namespace signudoc \
  -f deploy/reyemtech/workload/values.yaml
```

Review the PDB beside the rendered Deployment and review the infrastructure separately. Use admission checks on the resolved private manifests before deploying. See the [generic Kubernetes guide](kubernetes.md#migrations-and-recovery) for migration and rollback behavior.
