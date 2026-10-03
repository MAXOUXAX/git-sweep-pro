# The url and sha256 are rewritten by scripts/pack-cli.mjs on every release.
class GitSweepPro < Formula
  desc "Safely prune local Git branches whose remote upstream is gone"
  homepage "https://github.com/MAXOUXAX/git-sweep-pro"
  url "https://github.com/MAXOUXAX/git-sweep-pro/releases/download/v1.4.0/git-sweep-pro-cli-1.4.0.tar.gz"
  sha256 "2a7dcd63a173dfe9eef61ffb9a8c9623e18786cf436ef2c05a9c3d19b78f7e01"
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
