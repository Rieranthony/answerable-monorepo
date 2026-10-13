# The object store that holds this environment's Terraform state, with a credential of its own (D27).
mock_provider "civo" {
  override_during = plan

  mock_resource "civo_object_store_credential" {
    defaults = {
      access_key_id = "STATEACCESSKEY"
    }
  }
}

variables {
  environment = "staging"
}

run "creates_the_state_bucket_and_its_credential" {
  command = plan

  assert {
    condition     = civo_object_store.this.name == "answerable-staging-tfstate"
    error_message = "The state bucket must be named answerable-<environment>-tfstate."
  }

  assert {
    condition     = civo_object_store_credential.this.name == "answerable-staging-tfstate"
    error_message = "The state credential must be named answerable-<environment>-tfstate."
  }

  assert {
    condition     = civo_object_store.this.access_key_id == "STATEACCESSKEY"
    error_message = "The bucket must be owned by the state credential, not by a credential Civo makes on the side."
  }

  assert {
    condition     = civo_object_store.this.max_size_gb == 500 && civo_object_store.this.region == "LON1"
    error_message = "The bucket must be the smallest block, 500 GB, in LON1."
  }

  assert {
    condition     = output.endpoint == "https://objectstore.lon1.civo.com"
    error_message = "The S3 endpoint must be the region's object store host, as backend.tf names it."
  }
}

run "refuses_a_size_that_is_not_a_whole_block" {
  command = plan

  variables {
    max_size_gb = 750
  }

  expect_failures = [var.max_size_gb]
}
