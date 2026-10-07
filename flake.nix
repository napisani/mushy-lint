{
  description = "mushy-lint - semantic classification over tree-sitter source targets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        # Only x86_64-darwin (Intel Macs) needs the 26.05 branch; everything
        # else (arm64 Macs, Linux) stays on nixpkgs-unstable.
        nixpkgs' = if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs;
        pkgs = import nixpkgs' { inherit system; };
        inherit (pkgs) bun;
        deps = builtins.fromJSON (builtins.readFile ./nix-deps.json);
        runtimePackages = pkgs.lib.mapAttrsToList (name: source: {
          inherit name;
          archive = pkgs.fetchurl source;
        }) deps.packages;
      in
      {
        packages.default =
          assert pkgs.lib.assertMsg (
            deps.lockHash == builtins.hashString "sha256" (builtins.readFile ./bun.lock)
          ) "Nix dependency manifest is stale; run bun run nix:deps.";
          pkgs.stdenv.mkDerivation {
            pname = "mushy-lint";
            version = self.shortRev or "0.0.0";
            src = pkgs.lib.cleanSourceWith {
              src = ./.;
              filter =
                path: type:
                pkgs.lib.cleanSourceFilter path type
                && !(builtins.elem (builtins.baseNameOf path) [
                  "node_modules"
                  "dist"
                ]);
            };

            nativeBuildInputs = [ bun ];

            buildPhase = ''
              runHook preBuild
              export HOME=$TMPDIR
              ${pkgs.lib.concatMapStringsSep "\n" (dependency: ''
                mkdir -p ${pkgs.lib.escapeShellArg "node_modules/${dependency.name}"}
                tar -xf ${dependency.archive} --strip-components=1 -C ${pkgs.lib.escapeShellArg "node_modules/${dependency.name}"}
              '') runtimePackages}
              ${bun}/bin/bun run build:bin
              runHook postBuild
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp dist/mushy-lint $out/bin/mushy-lint
            '';

            # `bun build --compile` appends the bundle to the bun executable; stripping truncates it.
            dontStrip = true;
          };

        devShells.default = pkgs.mkShell {
          packages = [
            bun
            pkgs.git
            pkgs.tree-sitter
          ];
        };
      }
    );
}
