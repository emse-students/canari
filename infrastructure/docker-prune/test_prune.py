"""Unit tests for the release-image plan. Run from the repo root:

    python3 -m unittest discover -s infrastructure/docker-prune -p "test_*.py"
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prune  # noqa: E402

P = "ghcr.io/emse-students/canari/"


def img(repo, tag, ident=None):
    return {"id": ident or f"sha256:{repo}-{tag}", "repository": repo, "tag": tag}


def refs(items):
    return sorted(e["ref"] for e in items)


class PlanTest(unittest.TestCase):
    def test_keeps_newest_n_and_removes_the_rest(self):
        images = [img(P + "core-service", f"v1.1.{n}") for n in range(0, 6)]
        plan = prune.plan_release_removal(images, set(), set(), 3)
        self.assertEqual(refs(plan["keep"]), [P + f"core-service:v1.1.{n}" for n in (3, 4, 5)])
        self.assertEqual(refs(plan["remove"]), [P + f"core-service:v1.1.{n}" for n in (0, 1, 2)])

    def test_semver_order_is_numeric_and_prerelease_is_below_stable(self):
        images = [img(P + "x", t) for t in ("v1.10.0", "v1.9.0", "v1.10.0-alpha.2", "v1.10.0-alpha.10")]
        plan = prune.plan_release_removal(images, set(), set(), 2)
        self.assertEqual(refs(plan["keep"]), [P + "x:v1.10.0", P + "x:v1.10.0-alpha.10"])

    def test_container_referenced_image_is_never_removed(self):
        old = img(P + "core-service", "v1.0.0", "sha256:inuse")
        images = [old] + [img(P + "core-service", f"v1.1.{n}") for n in range(4)]
        plan = prune.plan_release_removal(images, {"sha256:inuse"}, set(), 3)
        self.assertNotIn(P + "core-service:v1.0.0", refs(plan["remove"]))
        self.assertIn("referenced by a container", [e["reason"] for e in plan["keep"]])
        # the same fixture WITHOUT the container is removed: the guard is what saved it
        plan = prune.plan_release_removal(images, set(), set(), 3)
        self.assertIn(P + "core-service:v1.0.0", refs(plan["remove"]))

    def test_shared_id_protects_every_tag(self):
        images = [img(P + "a", "v1.0.0", "sha256:s"), img(P + "a", "v1.0.1", "sha256:s")]
        images += [img(P + "a", f"v2.0.{n}") for n in range(3)]
        plan = prune.plan_release_removal(images, {"sha256:s"}, set(), 3)
        self.assertEqual(plan["remove"], [])

    def test_compose_named_ref_is_kept(self):
        images = [img(P + "a", f"v1.0.{n}") for n in range(5)]
        plan = prune.plan_release_removal(images, set(), {P + "a:v1.0.0"}, 3)
        self.assertEqual(refs(plan["remove"]), [P + "a:v1.0.1"])

    def test_out_of_allowlist_images_are_not_even_listed(self):
        images = [
            img(P + "a", "dev"),
            img(P + "a", "latest"),
            img(P + "a", "v1.0.0x"),
            img("other/project", "v1.0.0"),
            img("ghcr.io/emse-students/sky/app", "v1.0.0"),
            img(P + "a", "v9.9.9"),
        ]
        plan = prune.plan_release_removal(images, set(), set(), 1)
        self.assertEqual(plan["remove"], [])
        self.assertEqual(refs(plan["keep"]), [P + "a:v9.9.9"])

    def test_repositories_are_ranked_independently(self):
        images = [img(P + "a", "v1.0.0"), img(P + "b", "v1.0.0")]
        plan = prune.plan_release_removal(images, set(), set(), 1)
        self.assertEqual(plan["remove"], [])

    def test_keep_below_one_is_refused(self):
        with self.assertRaises(ValueError):
            prune.plan_release_removal([], set(), set(), 0)

    def test_not_applied_removes_nothing(self):
        plan = {"keep": [], "remove": [{"ref": P + "a:v1.0.0", "id": "x"}]}
        self.assertEqual(
            prune.remove_releases(plan, False), [{"ref": P + "a:v1.0.0", "skipped": "not applied"}]
        )

    def test_compose_refs_read_and_unreadable_file_raises(self):
        with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False, encoding="utf-8") as f:
            f.write(f"image: {P}core-service:v1.1.2\nimage: redis:7\nimage: {P}frontend:${{TAG}}\n")
        try:
            self.assertEqual(prune.compose_image_refs([f.name]), {P + "core-service:v1.1.2"})
        finally:
            os.unlink(f.name)
        with self.assertRaises(OSError):
            prune.compose_image_refs(["/nonexistent/compose.yml"])


if __name__ == "__main__":
    unittest.main()
