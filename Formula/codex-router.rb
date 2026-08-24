class CodexRouter < Formula
  desc "Use external coding models inside the Codex App and CLI"
  homepage "https://github.com/duolahypercho/codex-router"
  url "https://github.com/duolahypercho/codex-router/releases/download/v0.4.0-beta.4/codex-router-0.4.0-beta.4.tar.gz"
  sha256 "dfd08cccc7f60c91e854741b92f8154be02ff8882affaed3db7b4e223c95b350"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    system "npm", "ci", "--omit=dev", "--prefix", libexec

    (bin/"codex-router").write <<~SH
      #!/bin/sh
      source_root=$(CDPATH= cd -- "#{opt_libexec}" && pwd -P)
      export PATH="#{Formula["node"].opt_bin}:$PATH"
      export CODEX_ROUTER_SOURCE_ROOT="$source_root"
      export CODEX_ROUTER_NODE_BIN="#{Formula["node"].opt_bin}/node"
      export CODEX_ROUTER_PACKAGE_MANAGER=homebrew
      exec "$source_root/bin/model-router" codex "$@"
    SH
  end

  def post_install
    state_root = ENV["MODEL_ROUTER_STATE_DIR"] || ENV["CODEX_ROUTER_STATE_DIR"] ||
                 ENV["KIMI_CODEX_STATE_DIR"] || (Pathname(Dir.home)/".codex/codex-router")
    manifest_path = Pathname(state_root)/"install-manifest.json"
    return unless manifest_path.exist?

    manifest = JSON.parse(manifest_path.read)
    return if manifest.dig("current", "packageManager") != "homebrew"

    system bin/"codex-router", "install"
  rescue JSON::ParserError
    opoo "Existing Codex Router install manifest is invalid; run `codex-router setup`."
  end

  def caveats
    <<~EOS
      Finish the one-time Codex integration with:
        codex-router setup --guided

      Before `brew uninstall codex-router`, remove the per-user service and
      managed Codex config with:
        codex-router uninstall
    EOS
  end

  test do
    system Formula["node"].opt_bin/"node", libexec/"src/install-plan.mjs", "status", "node-deps"
    output = shell_output("#{bin}/codex-router providers list --json")
    assert_match '"providers":', output
  end
end
