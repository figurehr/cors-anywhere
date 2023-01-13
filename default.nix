with builtins;
{ nixpkgs-json ? fromJSON (readFile ./nixpkgs.json), pkgs ? import
  (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${nixpkgs-json.rev}.tar.gz";
    sha256 = nixpkgs-json.sha256;
  }) { inherit pkgs; } }:
let in pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    nodejs-19_x
    nodePackages_latest.yarn
  ];
}

