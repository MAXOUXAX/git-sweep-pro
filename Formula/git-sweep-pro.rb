# The url and sha256 are rewritten by scripts/pack-cli.mjs on every release.
class GitSweepPro < Formula
  desc "Safely prune local Git branches whose remote upstream is gone"
  homepage "https://github.com/MAXOUXAX/git-sweep-pro"
  url "https://github.com/MAXOUXAX/git-sweep-pro/releases/download/v2.0.1/git-sweep-pro-cli-2.0.1.tar.gz"
  sha256 "bb726dd8844a0c6a833bf828d3341fb0923891fb0955e2542880639bf3d268e4"
  license "GPL-3.0-or-later"

  depends_on "node"

  def install
    libexec.install "package.json", "dist"
    %w[gsp git-sweep-pro].each do |name|
      (bin/name).write <<~SH
        #!/bin/sh
        exec "#{formula_opt_bin("node")}/node" "#{libexec}/dist/cli/main.js" "$@"
      SH
      (bin/name).chmod 0755
    end
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/gsp version").strip
    system "git", "init", "--quiet"
    assert_match "No stale branches found.", shell_output("#{bin}/gsp list --no-fetch 2>&1")
  end
end
