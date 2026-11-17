# frozen_string_literal: true

require_relative "lib/sooner_email"

Gem::Specification.new do |spec|
  spec.name = "sooner-email"
  spec.version = SoonerEmail::VERSION
  spec.summary = "First-party Ruby client for the Sooner email API"
  spec.description = "Email sending, batch delivery, pagination, scheduling and cancellation with explicit idempotency and request deadlines."
  spec.authors = ["Sooner"]
  spec.license = "MIT"
  spec.homepage = "https://sooner.dev"
  spec.required_ruby_version = ">= 3.1"
  spec.files = Dir.chdir(__dir__) { Dir["lib/**/*.rb", "README.md", "LICENSE"] }
  spec.require_paths = ["lib"]
  spec.metadata = {
    "source_code_uri" => "https://github.com/Quad-Labs-LLC/sooner-sdks/tree/main/ruby",
    "documentation_uri" => "https://sooner.dev/docs"
  }
end
