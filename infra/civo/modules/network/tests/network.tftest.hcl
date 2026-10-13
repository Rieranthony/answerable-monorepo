# The private network: named for its environment, on a private range that cannot collide with the cluster's own.
mock_provider "civo" {}

variables {
  environment = "staging"
  cidr_v4     = "10.10.0.0/24"
}

run "names_the_network_for_its_environment" {
  command = plan

  assert {
    condition     = civo_vpc_network.this.label == "answerable-staging-network"
    error_message = "The network must be named answerable-<environment>-network."
  }

  assert {
    condition     = civo_vpc_network.this.cidr_v4 == "10.10.0.0/24"
    error_message = "The network must use the range it was given."
  }

  assert {
    condition     = output.cidr_v4 == "10.10.0.0/24"
    error_message = "The module must output the range for the firewalls that admit the network."
  }
}

run "refuses_an_unknown_environment" {
  command = plan

  variables {
    environment = "dev"
  }

  expect_failures = [var.environment]
}

run "refuses_a_public_range" {
  command = plan

  variables {
    cidr_v4 = "192.0.2.0/24"
  }

  expect_failures = [var.cidr_v4]
}

run "refuses_the_pod_and_service_ranges" {
  command = plan

  variables {
    cidr_v4 = "10.42.0.0/24"
  }

  expect_failures = [var.cidr_v4]
}

run "refuses_a_range_wider_than_a_slash_16" {
  command = plan

  variables {
    cidr_v4 = "10.0.0.0/8"
  }

  expect_failures = [var.cidr_v4]
}
