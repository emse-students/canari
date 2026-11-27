"""Proves the `school_mail` claim (10-mappings.yaml, `miconnect-claim-school-mail`) goes to the accounts it
is meant for and to no other, by EVALUATING the mapping the blueprint wrote on accounts made for the test.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied. Owner, 2026-11-27
(docs/wiki/mail-client-transport.md#eligibility): the real address reaches Canari's mail client only for
an account the CAS created, and only on a school domain. The Alumni address is typed by its holder at
Alumnforce and may name any mailbox, so an Alumni-created account never gets it - not even once it holds
a CAS link. It prints `SCHOOL-MAIL-OK` when every assertion held.
"""
from authentik.core.models import User
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection

MAPPING = "miconnect-claim-school-mail"
CANARI_PROVIDERS = {"miconnect-canari", "miconnect-canari-dev", "miconnect-canari-local"}


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


mapping = ScopeMapping.objects.get(name=MAPPING)
check(mapping.scope_name == "school_mail", "the mapping has its own scope, school_mail")

bound = {p.name for p in OAuth2Provider.objects.filter(property_mappings=mapping)}
check(bound == CANARI_PROVIDERS, f"bound to Canari's three providers and no other ({sorted(bound)})")

cas = OAuthSource.objects.get(slug="cas-emse")
made = []


def account(username, email, cas_identifier=None):
    user = User.objects.create(username=f"{username}", email=email, name="School Mail Probe")
    made.append(user)
    if cas_identifier is not None:
        UserOAuthSourceConnection.objects.create(user=user, source=cas, identifier=cas_identifier)
    return user


def claim(user):
    return mapping.evaluate(user=user, request=None)


try:
    student = account("smc.student", "SMC.Student@etu.emse.fr", cas_identifier="smc.student")
    check(claim(student) == {"school_mail": "smc.student@etu.emse.fr"}, "a CAS student gets its address, lowercased")

    staff = account("smc.staff", "smc.staff@emse.fr", cas_identifier="smc.staff")
    check(claim(staff) == {"school_mail": "smc.staff@emse.fr"}, "a CAS staff member gets its address")

    elsewhere = account("smc.elsewhere", "smc@example.org", cas_identifier="smc.elsewhere")
    check(claim(elsewhere) == {}, "a CAS account whose address is not on a school domain gets nothing")

    subdomain = account("smc.sub", "smc.sub@mail.emse.fr", cas_identifier="smc.sub")
    check(claim(subdomain) == {}, "a subdomain is not a school domain")

    alumni = account("alumni-990001", "someone@emse.fr")
    check(claim(alumni) == {}, "an Alumni account with a school-looking address and no CAS link gets nothing")

    alumni_linked = account("alumni-990002", "someone.else@etu.emse.fr", cas_identifier="smc.linked")
    check(
        claim(alumni_linked) == {},
        "an Alumni-created account that LATER linked the CAS gets nothing: its address is still the typed one",
    )

    no_link = account("smc.nolink", "smc.nolink@etu.emse.fr")
    check(claim(no_link) == {}, "an account with no CAS link gets nothing")
finally:
    for user in made:
        user.delete()

print("SCHOOL-MAIL-OK")
