import os
import unittest
import tempfile
from pathlib import Path

# Set test environment before importing app
os.environ["ARCHERY_ADMIN_PIN"] = "9999"

import app


class OlympicArcheryApiTestCase(unittest.TestCase):

    def setUp(self):
        # Configure a temporary database for testing
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.temp_db.close()
        
        app.DB_PATH = Path(self.temp_db.name)
        app.init_database()
        
        self.client = app.app.test_client()

    def tearDown(self):
        # Remove temporary database
        try:
            if os.path.exists(self.temp_db.name):
                os.unlink(self.temp_db.name)
        except OSError:
            pass

    def test_home_page_status(self):
        """Verify the stadium home page loads with 200 OK."""
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Olympic Archery Arena", response.data)

    def test_leaderboard_empty(self):
        """Verify initial leaderboard is empty and has valid JSON structure."""
        response = self.client.get("/api/leaderboard")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["entries"], [])
        self.assertEqual(data["sessions"], 0)

    def test_score_submission_and_olympic_rules(self):
        """Verify score submission drops the lowest shot per target and calculates accuracy."""
        payload = {
            "player": "TestArcher",
            "level": "medium",
            "rounds": [
                [10, 10, 9, 2],  # best 3: 10 + 10 + 9 = 29
                [10, 9, 8, 0],   # best 3: 10 + 9 + 8 = 27
                [10, 10, 10, 7]  # best 3: 10 + 10 + 10 = 30
            ]
        }
        # Expected total = 29 + 27 + 30 = 86
        # Expected hits: 11 / 12 -> 91.7%
        # Expected tens: 6
        response = self.client.post("/api/score", json=payload)
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["total"], 86)
        self.assertEqual(data["tens"], 6)
        self.assertEqual(data["accuracy"], 91.7)
        self.assertEqual(data["rank"], 1)

    def test_score_validation(self):
        """Verify API rejects invalid inputs."""
        # Missing player name
        res = self.client.post("/api/score", json={"player": "", "level": "medium", "rounds": []})
        self.assertEqual(res.status_code, 400)

        # Invalid difficulty
        res = self.client.post("/api/score", json={"player": "Valid", "level": "impossible", "rounds": []})
        self.assertEqual(res.status_code, 400)

        # Incomplete rounds
        res = self.client.post("/api/score", json={"player": "Valid", "level": "easy", "rounds": [[10, 10, 10, 10]]})
        self.assertEqual(res.status_code, 400)

    def test_admin_reset_pin_protection(self):
        """Verify admin reset rejects incorrect PIN and accepts correct PIN."""
        # Incorrect PIN
        res = self.client.post("/api/admin/reset", json={"pin": "wrong_pin"})
        self.assertEqual(res.status_code, 403)

        # Correct PIN
        res = self.client.post("/api/admin/reset", json={"pin": "9999"})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])

    def test_input_events_endpoint(self):
        """Verify input events endpoint returns valid sequence numbers."""
        response = self.client.get("/api/input-events?after=0")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn("seq", data)
        self.assertIn("events", data)


if __name__ == "__main__":
    unittest.main()

