package fr.emse.mines_app_auth_service.repository;

import fr.emse.mines_app_auth_service.model.LinkedAccount;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface LinkedAccountRepository extends JpaRepository<LinkedAccount, UUID> {
    Optional<LinkedAccount> findByProviderAndProviderId(String provider, String providerId);
}
