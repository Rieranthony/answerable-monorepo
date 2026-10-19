# The deploy workflow's identity (D25): a ServiceAccount that can do what `helm upgrade` of charts/answerable, the
# id-env Secret and the ops Jobs need inside the answerable namespace, and nothing in any other namespace.
mock_provider "kubernetes" {}

variables {
  namespace = "answerable"
}

run "creates_the_service_account_and_its_token" {
  command = plan

  assert {
    condition     = kubernetes_service_account_v1.this.metadata[0].name == "deployer" && kubernetes_service_account_v1.this.metadata[0].namespace == "answerable"
    error_message = "The deployer must be the ServiceAccount deployer in the answerable namespace."
  }

  assert {
    condition     = kubernetes_service_account_v1.this.automount_service_account_token == false
    error_message = "No pod runs as the deployer, so its token must never be mounted into one."
  }

  assert {
    condition = (
      kubernetes_secret_v1.token.type == "kubernetes.io/service-account-token"
      && kubernetes_secret_v1.token.metadata[0].annotations["kubernetes.io/service-account.name"] == "deployer"
      && kubernetes_secret_v1.token.metadata[0].namespace == "answerable"
      && kubernetes_secret_v1.token.wait_for_service_account_token
    )
    error_message = "The token must be a long-lived ServiceAccount token Secret bound to the deployer."
  }
}

run "grants_what_helm_upgrade_needs_in_its_namespace_only" {
  command = plan

  assert {
    condition     = kubernetes_role_v1.this.metadata[0].namespace == "answerable" && kubernetes_role_binding_v1.this.metadata[0].namespace == "answerable"
    error_message = "The deployer's write access must be a Role in the answerable namespace, never a ClusterRole."
  }

  assert {
    condition = (
      kubernetes_role_binding_v1.this.role_ref[0].kind == "Role"
      && kubernetes_role_binding_v1.this.role_ref[0].name == kubernetes_role_v1.this.metadata[0].name
      && kubernetes_role_binding_v1.this.subject[0].kind == "ServiceAccount"
      && kubernetes_role_binding_v1.this.subject[0].name == "deployer"
      && kubernetes_role_binding_v1.this.subject[0].namespace == "answerable"
      && length(kubernetes_role_binding_v1.this.subject) == 1
    )
    error_message = "The binding must give the deployer's Role to the deployer and to nobody else."
  }

  assert {
    condition = alltrue([
      for resource in [
        "deployments", "jobs", "services", "secrets", "configmaps", "serviceaccounts", "ingresses", "networkpolicies",
        "horizontalpodautoscalers", "poddisruptionbudgets", "roles", "rolebindings",
      ] :
      anytrue([
        for rule in kubernetes_role_v1.this.rule :
        contains(rule.resources, resource) && length(setsubtract(["get", "list", "watch", "create", "update", "patch", "delete"], rule.verbs)) == 0
      ])
    ])
    error_message = "The deployer must be able to manage every kind of object charts/answerable renders."
  }

  assert {
    condition = anytrue([
      for rule in kubernetes_role_v1.this.rule : contains(rule.resources, "pods/log") && contains(rule.verbs, "get")
    ])
    error_message = "The deployer must read a failed migration Job's logs."
  }

  assert {
    condition = alltrue(flatten([
      for rule in kubernetes_role_v1.this.rule : [
        !contains(rule.verbs, "*"), !contains(rule.resources, "*"), !contains(rule.api_groups, "*"),
        length(setintersection(rule.verbs, ["escalate", "bind", "impersonate"])) == 0,
        length(setintersection(rule.resources, ["pods/exec", "pods/attach", "pods/portforward", "namespaces", "nodes"])) == 0,
      ]
    ]))
    error_message = "No wildcards, no escalate, bind or impersonate, no exec or port-forward, nothing about namespaces or nodes."
  }

  assert {
    condition = alltrue([
      for rule in kubernetes_role_v1.this.rule :
      length(setsubtract(rule.verbs, ["get", "list", "watch"])) == 0 if contains(rule.resources, "pods")
    ])
    error_message = "Pods belong to their controllers: the deployer reads them and never creates or deletes them."
  }

  assert {
    condition = alltrue([
      for rule in kubernetes_role_v1.this.rule :
      length(setsubtract(rule.api_groups, ["", "events.k8s.io", "apps", "batch", "autoscaling", "policy", "networking.k8s.io", "rbac.authorization.k8s.io"])) == 0
    ])
    error_message = "The deployer's rules name Kubernetes' own API groups only; charts/answerable renders no custom resource."
  }
}

run "exposes_its_token_and_the_cluster_ca_only_as_sensitive_values" {
  command = plan

  override_resource {
    target          = kubernetes_secret_v1.token
    override_during = plan
    values = {
      data = {
        token    = "a-token"
        "ca.crt" = "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n"
      }
    }
  }

  assert {
    condition     = issensitive(output.token) && issensitive(output.ca_certificate)
    error_message = "KUBE_TOKEN and KUBE_CA leave the module only as sensitive values."
  }

  assert {
    condition     = nonsensitive(output.token) == "a-token" && startswith(nonsensitive(output.ca_certificate), "-----BEGIN CERTIFICATE-----")
    error_message = "The outputs must be the token Secret's token and ca.crt."
  }
}
