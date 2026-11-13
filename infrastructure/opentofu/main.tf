# PLANNED infrastructure-as-code for one TITAN region (apply once per region:
# primary and DR). Validated with `tofu validate`; NEVER applied from this
# repository - it creates nothing until an operator supplies a cluster and
# runs it deliberately.
#
# Scope: the platform dependencies inside an existing Kubernetes cluster
# (operators and brokers). The cluster itself, networks, object storage
# buckets and DNS belong to the hosting provider module chosen by the
# deploying agency and are intentionally not guessed here.
#
# The TITAN services are NOT installed by this module: they are delivered by
# Argo CD from Git (see ../kubernetes/argocd), so that a region can be
# rebuilt from the repository alone.

terraform {
  required_version = ">= 1.8.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.30.0, < 3.0.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.14.0, < 3.0.0"
    }
  }

  # State holds no secrets from this module, but must still be stored remotely,
  # encrypted and locked. Configure the backend per environment.
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context
  }
}

locals {
  namespaces = {
    titan               = "restricted"
    titan-data          = "restricted"
    titan-messaging     = "restricted"
    titan-identity      = "baseline"
    titan-observability = "baseline"
  }

  common_labels = {
    "app.kubernetes.io/part-of" = "titan"
    "titan.io/region-role"      = var.region_role
  }
}

resource "kubernetes_namespace" "titan" {
  for_each = local.namespaces

  metadata {
    name = each.key
    labels = merge(local.common_labels, {
      "pod-security.kubernetes.io/enforce" = each.value
    })
  }
}

# PostgreSQL operator (the Cluster resources are applied through GitOps).
resource "helm_release" "cloudnative_pg" {
  name             = "cnpg"
  namespace        = "cnpg-system"
  create_namespace = true
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = var.chart_versions.cloudnative_pg
  atomic           = true
  timeout          = 600
}

# Event broker: three-node JetStream cluster.
resource "helm_release" "nats" {
  name       = "nats"
  namespace  = kubernetes_namespace.titan["titan-messaging"].metadata[0].name
  repository = "https://nats-io.github.io/k8s/helm/charts/"
  chart      = "nats"
  version    = var.chart_versions.nats
  values     = [file("${path.module}/../kubernetes/platform/nats-values.yaml")]
  atomic     = true
  timeout    = 600
}

# Secrets are synchronised from the secret manager; none live in Git or in state.
resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  namespace        = "external-secrets"
  create_namespace = true
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = var.chart_versions.external_secrets
  atomic           = true
}

# Cluster-state backups to the other region.
resource "helm_release" "velero" {
  name             = "velero"
  namespace        = "velero"
  create_namespace = true
  repository       = "https://vmware-tanzu.github.io/helm-charts"
  chart            = "velero"
  version          = var.chart_versions.velero
  atomic           = true

  set {
    name  = "configuration.backupStorageLocation[0].name"
    value = "dr-region"
  }
  set {
    name  = "configuration.backupStorageLocation[0].bucket"
    value = var.velero_bucket
  }
}

# GitOps controller: everything else is reconciled from the repository.
resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.chart_versions.argo_cd
  atomic           = true
  timeout          = 900
}
