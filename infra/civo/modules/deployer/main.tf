locals {
  manage = ["get", "list", "watch", "create", "update", "patch", "delete"]
  read   = ["get", "list", "watch"]

  # What `helm upgrade --install answerable charts/answerable --atomic --wait` and the secrets step
  # (`sops --decrypt … | kubectl apply`) touch in the answerable namespace. Helm keeps its release records in Secrets,
  # so the deployer manages Secrets; Roles and RoleBindings are for the ops Jobs' own Role (B3), and Kubernetes refuses
  # a RoleBinding that grants more than the deployer itself holds. Pods are only read: their controllers own them.
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
    { api_groups = ["cert-manager.io"], resources = ["certificates", "certificaterequests"], verbs = local.read },
  ]

  # Only in namespaces read_namespaces lists, which neither root does: there the deployer reads what explains a failed
  # rollout (the ingress controller's pods, logs and events) and nothing that holds a credential.
  read_rules = [
    { api_groups = [""], resources = ["pods", "services", "endpoints", "events", "configmaps"], verbs = local.read },
    { api_groups = [""], resources = ["pods/log"], verbs = ["get"] },
    { api_groups = ["apps"], resources = ["deployments", "daemonsets", "replicasets"], verbs = local.read },
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

resource "kubernetes_role_v1" "read" {
  for_each = toset(var.read_namespaces)

  metadata {
    name      = "deployer-read"
    namespace = each.value
  }

  dynamic "rule" {
    for_each = local.read_rules

    content {
      api_groups = rule.value.api_groups
      resources  = rule.value.resources
      verbs      = rule.value.verbs
    }
  }
}

resource "kubernetes_role_binding_v1" "read" {
  for_each = toset(var.read_namespaces)

  metadata {
    name      = "deployer-read"
    namespace = each.value
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.read[each.value].metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.this.metadata[0].name
    namespace = var.namespace
  }
}

# A long-lived token for the deployer (the deploy workflow's KUBE_TOKEN). Kubernetes fills the Secret's token and
# ca.crt; deleting the Secret revokes the token, and `terraform apply -replace` on this resource rotates it.
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
