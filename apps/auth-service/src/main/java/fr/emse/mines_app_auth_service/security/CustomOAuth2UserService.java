package fr.emse.mines_app_auth_service.security;

import fr.emse.mines_app_auth_service.model.LinkedAccount;
import fr.emse.mines_app_auth_service.model.User;
import fr.emse.mines_app_auth_service.repository.LinkedAccountRepository;
import fr.emse.mines_app_auth_service.repository.UserRepository;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;

@Service
public class CustomOAuth2UserService extends DefaultOAuth2UserService {

    private final UserRepository userRepository;
    private final LinkedAccountRepository linkedAccountRepository;

    public CustomOAuth2UserService(UserRepository userRepository, LinkedAccountRepository linkedAccountRepository) {
        this.userRepository = userRepository;
        this.linkedAccountRepository = linkedAccountRepository;
    }

    @Override
    @Transactional
    public OAuth2User loadUser(OAuth2UserRequest userRequest) throws OAuth2AuthenticationException {
        OAuth2User oauth2User = super.loadUser(userRequest);

        String provider = userRequest.getClientRegistration().getRegistrationId();
        String providerId = oauth2User.getName(); // Usually sub or id
        // Note: github uses 'id' (integer) as name, google uses 'sub'
        // We should handle extraction more robustly in prod but this works for basic cases
        // Better:
        if (oauth2User.getAttribute("id") != null) {
             providerId = String.valueOf(oauth2User.getAttribute("id"));
        }
        
        String email = oauth2User.getAttribute("email");
        String name = oauth2User.getAttribute("name");
        if(name == null) name = oauth2User.getAttribute("login"); // Github

        processUser(provider, providerId, email, name);

        return oauth2User;
    }

    private void processUser(String provider, String providerId, String email, String name) {
        // 1. Check if this specific account (provider + id) already exists
        Optional<LinkedAccount> existingAccount = linkedAccountRepository.findByProviderAndProviderId(provider, providerId);
        
        if (existingAccount.isPresent()) {
            return; // User already exists and is linked, nothing to do (Log in)
        }

        User user = null;

        // 2. Check if user is already authenticated (Linking account scenario)
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.isAuthenticated() && !(authentication instanceof AnonymousAuthenticationToken)) {
            if (authentication.getPrincipal() instanceof OAuth2User) {
                OAuth2User currentUser = (OAuth2User) authentication.getPrincipal();
                // Strategy: Find DB user by the email of the currently logged-in user
                String currentEmail = currentUser.getAttribute("email");
                if (currentEmail != null) {
                    Optional<User> dbUser = userRepository.findByEmail(currentEmail);
                    if (dbUser.isPresent()) {
                        user = dbUser.get();
                    }
                }
            }
        }

        // 3. If not already authenticated, or user look up failed, fall back to email matching or creation
        if (user == null) {
            Optional<User> existingUser = userRepository.findByEmail(email);

            if (existingUser.isPresent()) {
                // Case: User exists (via another provider), so we LINK this new provider
                user = existingUser.get();
            } else {
                // Case: New User completely
                user = new User(name, email);
                user = userRepository.save(user);
            }
        }

        // Create the Link
        LinkedAccount newLink = new LinkedAccount(provider, providerId, email, user);
        linkedAccountRepository.save(newLink);
    }
}
