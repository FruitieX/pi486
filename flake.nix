{
  description = "pi486 — 86Box appliance middleware";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        rust = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = [ "aarch64-unknown-linux-gnu" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            # Rust
            rust
            pkgs.pkg-config
            pkgs.libudev-zero # serialport sys dep

            # Node.js (writer-ui)
            pkgs.nodejs_22
            pkgs.nodePackages.npm

            # ESP32 / Arduino
            pkgs.arduino-cli

            # Useful tools
            pkgs.cargo-watch
          ];

          shellHook = ''
            echo "pi486 dev shell"
            echo "  rust:  $(rustc --version)"
            echo "  node:  $(node --version)"
            echo "  cargo: $(cargo --version)"
          '';

          # Needed for serialport-rs to find libudev
          PKG_CONFIG_PATH = "${pkgs.libudev-zero}/lib/pkgconfig";
        };
      }
    );
}
