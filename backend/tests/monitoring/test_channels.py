"""Notification channels read from an Alertmanager's routes."""

import pytest

from omnikrux.monitoring.alerts.tool.channels import (
    PATTERN_REASON,
    ChannelsUnreadable,
    parse_channels,
    read_channels,
)

CONFIG = """
route:
  receiver: default-mail
  routes:
    - receiver: ops-slack
      matchers: ['team="ops"', 'severity=~"critical|warning"']
    - receiver: db-pager
      match: {team: db}
    - receiver: sre
      matchers: ['team="sre"']
"""


def test_channels_follow_routes():
    assert [(c.receiver, dict(c.labels), c.usable) for c in parse_channels(CONFIG)] == [
        ("default-mail", {}, True),
        ("ops-slack", {"team": "ops"}, False),
        ("db-pager", {"team": "db"}, True),
        ("sre", {"team": "sre"}, True),
    ]


def test_channels_say_why_and_where():
    channels = parse_channels(CONFIG)
    assert [c.path for c in channels] == ["default", "routes[0]", "routes[1]", "routes[2]"]
    assert channels[1].reason == PATTERN_REASON and channels[2].reason is None


def test_nested_routes_inherit_receiver_and_parent_labels_and_duplicates_collapse():
    channels = parse_channels(
        """
route:
  receiver: root
  routes:
    - matchers: ['team="a"']
      receiver: a
      routes:
        - matchers: ['severity="page"']
        - match_re: {env: "pr.*"}
          receiver: b
    - receiver: a
      match: {team: a}
"""
    )
    assert [(c.receiver, dict(c.labels), c.usable, c.path) for c in channels] == [
        ("root", {}, True, "default"),
        ("a", {"team": "a"}, True, "routes[0]"),
        ("a", {"team": "a", "severity": "page"}, True, "routes[0].routes[0]"),
        ("b", {"team": "a"}, False, "routes[0].routes[1]"),
    ]


def test_unreadable_configuration():
    with pytest.raises(ChannelsUnreadable):
        parse_channels("route: [unclosed")
    with pytest.raises(ChannelsUnreadable):
        parse_channels("receivers: []")


async def test_read_channels_from_the_status(fake_alertmanager, direct):
    fake_alertmanager.config_yaml = CONFIG
    t = direct(fake_alertmanager.url, type="alertmanager", name="Alerts")
    assert [c.receiver for c in await read_channels(t, "Alerts")] == [
        "default-mail",
        "ops-slack",
        "db-pager",
        "sre",
    ]
    fake_alertmanager.config_yaml = "route: [unclosed"
    with pytest.raises(ChannelsUnreadable) as caught:
        await read_channels(t, "Alerts")
    assert caught.value.message == (
        "Alerts's configuration couldn't be read, so its channels can't be listed."
    )
