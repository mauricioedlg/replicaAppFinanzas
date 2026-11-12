from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model
from django.db.models import Q


class IdentifierBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        identifier = username or kwargs.get("identifier")
        if not identifier or password is None:
            return None
        user = get_user_model().objects.filter(Q(username__iexact=identifier) | Q(email__iexact=identifier)).first()
        if user is None:
            get_user_model()().set_password(password)
        elif user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
