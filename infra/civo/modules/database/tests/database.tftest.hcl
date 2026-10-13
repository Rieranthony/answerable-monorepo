# The managed PostgreSQL 17 (D26): on the private network, behind a firewall that admits 5432 from that network only,
# one node in staging and three (one primary, two standbys) in production.
mock_provider "civo" {
  override_during = plan

  mock_resource "civo_vpc_firewall" {
    defaults = {
      id = "33333333-3333-4333-8333-333333333333"
    }
  }
}

variables {
  environment  = "staging"
  network_id   = "22222222-2222-4222-8222-222222222222"
  network_cidr = "10.10.0.0/24"
  size         = "g3.db.small"
  nodes        = 1
}

run "creates_postgresql_17_on_the_private_network" {
  command = plan

  assert {
    condition     = civo_database.this.name == "answerable-staging-database"
    error_message = "The database must be named answerable-<environment>-database."
  }

  assert {
    condition     = civo_database.this.engine == "postgresql" && civo_database.this.version == "17"
    error_message = "The database must be PostgreSQL 17, the version every suite runs on (D26)."
  }

  assert {
    condition     = civo_database.this.network_id == "22222222-2222-4222-8222-222222222222"
    error_message = "The database must join the environment's private network."
  }

  assert {
    condition     = civo_database.this.firewall_id == "33333333-3333-4333-8333-333333333333"
    error_message = "The database must sit behind its own firewall; Civo's default one is open to everyone."
  }

  assert {
    condition     = civo_database.this.size == "g3.db.small" && civo_database.this.nodes == 1
    error_message = "The database must have the size and node count it was given."
  }
}

run "admits_postgres_from_the_private_network_only" {
  command = plan

  assert {
    condition     = civo_vpc_firewall.this.name == "answerable-staging-database" && civo_vpc_firewall.this.create_default_rules == false
    error_message = "The database firewall must be answerable-<environment>-database and carry only its declared rules."
  }

  assert {
    condition     = length(civo_vpc_firewall.this.ingress_rule) == 1
    error_message = "The database firewall admits one thing: PostgreSQL from the private network."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.protocol == "tcp" && rule.port_range == "5432" && rule.cidr == toset(["10.10.0.0/24"]) && rule.action == "allow"
    ])
    error_message = "PostgreSQL must be admitted on 5432 from the private network's range only."
  }

  assert {
    condition = alltrue([
      for rule in setunion(civo_vpc_firewall.this.ingress_rule, civo_vpc_firewall.this.egress_rule) :
      !contains(rule.cidr, "0.0.0.0/0") && !contains(rule.cidr, "::/0")
    ])
    error_message = "Nothing in the database firewall may reach or be reached from the whole internet."
  }
}

run "production_runs_three_nodes" {
  command = plan

  variables {
    environment = "production"
    size        = "g3.db.medium"
    nodes       = 3
  }

  assert {
    condition     = civo_database.this.name == "answerable-production-database" && civo_database.this.nodes == 3
    error_message = "Production's database must be answerable-production-database with three nodes."
  }
}

run "refuses_an_even_node_count" {
  command = plan

  variables {
    nodes = 2
  }

  expect_failures = [var.nodes]
}

run "refuses_a_size_that_is_not_a_database_size" {
  command = plan

  variables {
    size = "g4s.kube.medium"
  }

  expect_failures = [var.size]
}
