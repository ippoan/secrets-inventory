"""audit.py の pure function unit test (Refs #86)。

network / GCP / GitHub に一切触れない。CI (secret-audit.yml の self-test step) と
手元の `python3 -m unittest discover -s scripts/secret-audit` で走る。
"""

import datetime
import unittest

import audit


class ExtractRefsTest(unittest.TestCase):
    def test_basic_and_exclusions(self):
        yaml = """
        env:
          A: ${{ secrets.CI_APP_ID }}
          B: ${{secrets.KAGOYA_VPS_SSH_KEY}}
          C: ${{ secrets.GITHUB_TOKEN }}
          D: ${{ secrets.github_token }}
        """
        self.assertEqual(
            audit.extract_secret_refs(yaml),
            {"CI_APP_ID", "KAGOYA_VPS_SSH_KEY"},
        )

    def test_hyphen_and_lowercase_names(self):
        yaml = "X: ${{ secrets.NUXT_EGOV_CLIENT_SECRET }} Y: ${{ secrets.some-token }}"
        self.assertEqual(
            audit.extract_secret_refs(yaml),
            {"NUXT_EGOV_CLIENT_SECRET", "some-token"},
        )


class ExtractReusableTest(unittest.TestCase):
    def test_reusable_matched_actions_not(self):
        yaml = """
        jobs:
          ci:
            uses: ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main
          x:
            steps:
              - uses: actions/checkout@v4
          y:
            uses: "ippoan/ci-workflows/.github/workflows/auto-merge.yml@abc123"
        """
        self.assertEqual(
            audit.extract_reusable_uses(yaml),
            {
                ("ippoan", "ci-workflows", ".github/workflows/frontend-ci.yml", "main"),
                ("ippoan", "ci-workflows", ".github/workflows/auto-merge.yml", "abc123"),
            },
        )


class ResolveRefTest(unittest.TestCase):
    def setUp(self):
        self.gcp = {
            "RELEASE_WAVE_WEBHOOK_SECRET",
            "release-wave-webhook-secret",
            "cap-catalog-r2-token",
            "CI_APP_PRIVATE_KEY",
            "CI_APP_PRIVATE_KEY_PKCS8",
        }
        self.by_norm, self.rev = audit.build_ref_index(
            self.gcp, {"CI_APP_PRIVATE_KEY_PKCS8": ["CI_APP_PRIVATE_KEY"]}
        )

    def r(self, name):
        return audit.resolve_ref(name, self.gcp, self.by_norm, self.rev)

    def test_exact_beats_norm(self):
        # SNAKE/kebab の両方が GCP に居る時、exact match だけに解決する
        self.assertEqual(self.r("RELEASE_WAVE_WEBHOOK_SECRET"),
                         {"RELEASE_WAVE_WEBHOOK_SECRET"})

    def test_norm_fallback(self):
        self.assertEqual(self.r("CAP_CATALOG_R2_TOKEN"), {"cap-catalog-r2-token"})

    def test_alias(self):
        # GH の CI_APP_PRIVATE_KEY は exact + alias (PKCS8) の両 GCP secret に効く
        self.assertEqual(self.r("CI_APP_PRIVATE_KEY"),
                         {"CI_APP_PRIVATE_KEY", "CI_APP_PRIVATE_KEY_PKCS8"})

    def test_no_match(self):
        self.assertEqual(self.r("UNKNOWN_NAME"), set())


class SanitizeLabelKeyTest(unittest.TestCase):
    def test_lowercase_and_charset(self):
        self.assertEqual(
            audit.sanitize_label_key("ippoan", "HealthConnectReader"),
            "used-by-gh-ippoan-healthconnectreader",
        )
        self.assertEqual(
            audit.sanitize_label_key("ohishi-exp", "nuxt_dtako_logs"),
            "used-by-gh-ohishi-exp-nuxt_dtako_logs",
        )

    def test_max_63(self):
        key = audit.sanitize_label_key("ohishi-exp", "x" * 100)
        self.assertEqual(len(key), 63)


class ClassifyTest(unittest.TestCase):
    def base(self, **kw):
        info = {
            "labels": {},
            "cloud_run_direct": False,
            "cloud_run_indirect": False,
            "gh_refs": [],
            "in_gh_org": False,
            "in_cf": False,
        }
        info.update(kw)
        return audit.classify(info)

    def test_priority_order(self):
        self.assertEqual(self.base(labels={"pending-destroy": "20260601"})[0], "quarantined")
        self.assertEqual(self.base(labels={"keep": "always"})[0], "keep")
        self.assertEqual(self.base(cloud_run_direct=True)[0], "gcp-runtime")
        self.assertEqual(self.base(cloud_run_indirect=True)[0], "gcp-runtime")

    def test_gh_active_vs_dormant(self):
        ref = {"org": "ippoan", "repo": "x", "workflow": "ci.yml", "ran_recent": True}
        self.assertEqual(self.base(gh_refs=[ref])[0], "gh-active")
        ref2 = dict(ref, ran_recent=False)
        self.assertEqual(self.base(gh_refs=[ref2])[0], "gh-dormant")

    def test_cf_backup_requires_active_non_managed_label(self):
        b, _ = self.base(labels={"used-by-ippoan-auth-worker": "active"})
        self.assertEqual(b, "cf-backup")
        b, _ = self.base(labels={"used-by-ippoan-auth-worker": "removed"}, in_cf=True)
        self.assertEqual(b, "mirror-orphan")
        # 本スキャナ管理の used-by-gh-* ラベルは cf-backup 判定に使わない
        b, _ = self.base(labels={"used-by-gh-ippoan-x": "active-202607"})
        self.assertEqual(b, "candidate")

    def test_candidate_and_cf_unknown(self):
        b, ev = self.base()
        self.assertEqual(b, "candidate")
        b, ev = self.base(in_cf=None)
        self.assertEqual(b, "candidate")
        self.assertIn("CF 突合不能", ev[0])

    def test_mirror_orphan(self):
        self.assertEqual(self.base(in_gh_org=True)[0], "mirror-orphan")


class PlanLabelUpdatesTest(unittest.TestCase):
    def test_stamp_new_keep_foreign(self):
        existing = {"used-by-ippoan-auth-worker": "active", "keep": "always"}
        desired = {"used-by-gh-ippoan-x": "active-202607"}
        new = audit.plan_label_updates(existing, desired)
        self.assertEqual(new, {
            "used-by-ippoan-auth-worker": "active",
            "keep": "always",
            "used-by-gh-ippoan-x": "active-202607",
        })

    def test_flip_removed(self):
        existing = {"used-by-gh-ippoan-x": "active-202606"}
        new = audit.plan_label_updates(existing, {})
        self.assertEqual(new, {"used-by-gh-ippoan-x": "removed"})

    def test_no_change_returns_none(self):
        existing = {"used-by-gh-ippoan-x": "active-202607", "foo": "bar"}
        desired = {"used-by-gh-ippoan-x": "active-202607"}
        self.assertIsNone(audit.plan_label_updates(existing, desired))


class DestroyDueTest(unittest.TestCase):
    def test_due(self):
        today = datetime.date(2026, 7, 4)
        self.assertTrue(audit.destroy_due("20260604", today))   # ちょうど 30 日
        self.assertFalse(audit.destroy_due("20260610", today))  # 24 日
        self.assertFalse(audit.destroy_due("garbage", today))   # 不正値は destroy しない


if __name__ == "__main__":
    unittest.main()
