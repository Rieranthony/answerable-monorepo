# tflint for every Terraform directory under infra/ (`bun run infra:check` runs `tflint --recursive` with this file).
# The bundled Terraform ruleset with every rule on: naming, documented variables and outputs, typed variables,
# pinned providers, the standard module layout, nothing declared and left unused.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}
