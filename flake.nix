{
  description = "Klein development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{
      flake-parts,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, inputs', ... }:
        {
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.agent-browser
              pkgs.bubblewrap
              pkgs.bun
              pkgs.cloudflared
            ];
            shellHook = ''
              bun --version > .bun-version
            '';
          };
        };
    };
}
