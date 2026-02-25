package fr.emse.mines_app_auth_service.security;

import fr.emse.mines_app_auth_service.model.User;
import fr.emse.mines_app_auth_service.repository.UserRepository;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationSuccessHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.util.Optional;

@Component
public class OAuth2AuthenticationSuccessHandler extends SimpleUrlAuthenticationSuccessHandler {

    private final JwtTokenProvider tokenProvider;
    private final UserRepository userRepository;

    public OAuth2AuthenticationSuccessHandler(JwtTokenProvider tokenProvider, UserRepository userRepository) {
        this.tokenProvider = tokenProvider;
        this.userRepository = userRepository;
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response, Authentication authentication) throws IOException, ServletException {
        // Since we are using our CustomOAuth2UserService, the user is already saved/linked in DB.
        // We just need to fetch the local User entity to get the UUID.
        
        OAuth2User oAuth2User = (OAuth2User) authentication.getPrincipal();
        String email = oAuth2User.getAttribute("email");
        
        // This should theoretically strictly be present based on previous flow
        Optional<User> userOptional = userRepository.findByEmail(email);
        
        if (userOptional.isPresent()) {
            User user = userOptional.get();
            String token = tokenProvider.createToken(authentication, user.getId());
            
            // Redirect to client with token
            // Hardcoded for now, should be configurable or dynamic based on 'state'
            String targetUrl = UriComponentsBuilder.fromUriString("http://localhost:3000/oauth2/redirect") // Frontend URL
                    .queryParam("token", token)
                    .build().toUriString();
            
            getRedirectStrategy().sendRedirect(request, response, targetUrl);
        } else {
            super.onAuthenticationSuccess(request, response, authentication);
        }
    }
}
