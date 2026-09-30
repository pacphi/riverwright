#!/bin/sh
# Installed by Riverwright. Every push from this clone is checked by "riverwright guard pre-push".
# If Node is missing, exec fails and git aborts the push.
exec node "__RIVERWRIGHT_SCRIPT__" guard pre-push__RIVERWRIGHT_HOME_ARG__ -- "$@"
