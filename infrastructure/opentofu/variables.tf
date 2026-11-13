variable "kubeconfig_path" {
  description = "Path to the kubeconfig file of the target cluster."
  type        = string
}

variable "kube_context" {
  description = "kubeconfig context of the target cluster."
  type        = string
}

variable "region_role" {
  description = "Role of this region in the active-passive topology."
  type        = string

  validation {
    condition     = contains(["primary", "dr"], var.region_role)
    error_message = "region_role must be \"primary\" or \"dr\"."
  }
}

variable "chart_versions" {
  description = <<-EOT
    Helm chart versions of the platform dependencies. Deliberately without
    defaults: the deploying team pins versions it has tested together, and
    upgrades them through review.
  EOT
  type = object({
    cloudnative_pg   = string
    nats             = string
    external_secrets = string
    velero           = string
    argo_cd          = string
  })
}

variable "velero_bucket" {
  description = "Object storage bucket (in the OTHER region) receiving cluster-state backups."
  type        = string
}

output "namespaces" {
  description = "Namespaces created for the platform."
  value       = keys(kubernetes_namespace.titan)
}
