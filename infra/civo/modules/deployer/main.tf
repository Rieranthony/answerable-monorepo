locals {
  manage = ["get", "list", "watch", "create", "update", "patch", "delete"]
  read   = ["get", "list", "watch"]

  # What `helm upgrade --install answerable charts/answerable --atomic --wait`, the `id-env` Secret the deploy applies
  # and the ops Jobs it runs touch in the answerable namespace. Helm keeps its release records in Secrets, so the
  # deployer manages Secrets; Roles and RoleBindings are for the ops Jobs' own Role, and Kubernetes refuses a
  # RoleBinding that grants more than the deployer itself holds. Pods are only read: their controllers own them.
  rules = [
    { api_groups = [""], resources = ["configmaps", "secrets", "services", "serviceaccounts"], verbs = local.manage },
    { api_groups = [""], resources = ["pods", "endpoints", "events"], verbs = local.read },
    { api_groups = [""], resources = ["pods/log"], verbs = ["get"] },
    { api_groups = ["events.k8s.io"], resources = ["events"], verbs = local.read },
    { api_groups = ["apps"], resources = ["deployments"], verbs = local.manage },
    { api_groups = ["apps"], resources = ["replicasets"], verbs = local.read },
    { api_groups = ["batch"], resources = ["jobs"], verbs = local.manage },
    { api_groups = ["autoscaling"], resources = ["horizontalpodautoscalers"], verbs = local.manage },
    { api_groups = ["policy"], resources = ["poddisruptionbudgets"], verbs = local.manage },
    { api_groups = ["networking.k8s.io"], resources = ["ingresses", "networkpolicies"], verbs = local.manage },
    { api_groups = ["rbac.authorization.k8s.io"], resources = ["roles", "rolebindings"], verbs = local.manage },
  ]
}

# The deploy workflow's identity. No pod runs as it, so its token is never mounted.
resource "kubernetes_service_account_v1" "this" {
  metadata {
    name      = "deployer"
    namespace = var.namespace
  }

  automount_service_account_token = false
}

resource "kubernetes_role_v1" "this" {
  metadata {
    name      = "deployer"
    namespace = var.namespace
  }

  dynamic "rule" {
    for_each = local.rules

    content {
      api_groups = rule.value.api_groups
      resources  = rule.value.resources
      verbs      = rule.value.verbs
    }
  }
}

resource "kubernetes_role_binding_v1" "this" {
  metadata {
    name      = "deployer"
    namespace = var.namespace
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.this.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.this.metadata[0].name
    namespace = var.namespace
  }
}

# A long-lived token for the deployer (the environment's KUBE_TOKEN, which the github module writes). Kubernetes fills
# the Secret's token and ca.crt; deleting the Secret revokes the token, and `terraform apply -replace` on this
# resource rotates it and, in the same apply, the GitHub secret.
resource "kubernetes_secret_v1" "token" {
  metadata {
    name      = "deployer-token"
    namespace = var.namespace
    annotations = {
      "kubernetes.io/service-account.name" = kubernetes_service_account_v1.this.metadata[0].name
    }
  }

  type                           = "kubernetes.io/service-account-token"
  wait_for_service_account_token = true
}
