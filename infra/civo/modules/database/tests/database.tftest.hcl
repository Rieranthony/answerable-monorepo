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

# The administrator's URL for the bootstrap Job (the first-run contract's OPS_DATABASE_ADMIN_URL): every character
# of the login that is not unreserved in RFC 3986 is percent-encoded, a space as %20 (never +), so no password Civo
# generates can break the URL.
run "builds_the_admin_url_with_an_encoded_password" {
  command = plan

  override_resource {
    target          = civo_database.this
    override_during = plan
    values = {
      username     = "civo admin"
      password     = "p@ss:w/rd?#%+ ä&="
      private_ipv4 = "10.10.0.7"
      port         = 5432
    }
  }

  assert {
    condition     = output.admin_url == "postgres://civo%20admin:p%40ss%3Aw%2Frd%3F%23%25%2B%20%C3%A4%26%3D@10.10.0.7:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
    error_message = "The admin URL must be postgres://<user>:<password>@<private address>:<port>/postgres with verify-full against the mounted CA, the login percent-encoded."
  }
}

run "names_the_admin_database_it_is_given" {
  command = plan

  variables {
    admin_database = "defaultdb"
  }

  override_resource {
    target          = civo_database.this
    override_during = plan
    values = {
      username     = "civo"
      password     = "plain"
      private_ipv4 = "10.10.0.7"
      port         = 5432
    }
  }

  assert {
    condition     = output.admin_url == "postgres://civo:plain@10.10.0.7:5432/defaultdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
    error_message = "The admin URL must name the administrator's database the first real bootstrap confirms."
  }
}

run "refuses_an_admin_database_name_that_needs_encoding" {
  command = plan

  variables {
    admin_database = "post gres/x"
  }

  expect_failures = [var.admin_database]
}
