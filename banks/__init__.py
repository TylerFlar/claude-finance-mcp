from typing import Literal

ALL_BANKS = ["sofi", "bofa", "capitalone"]
BankName = Literal["sofi", "bofa", "capitalone"]

BANK_HOME_URLS = {
    "sofi": "https://www.sofi.com/wealth/app/banking",
    "bofa": (
        "https://secure.bankofamerica.com/myaccounts/brain/redirect.go"
        "?source=overview&target=accountsoverview"
    ),
    "capitalone": "https://myaccounts.capitalone.com/accountSummary",
}
